import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import { label, projectFor, readMetadata, sessionTitle } from './metadata.mjs';

const rolloutPattern = /^rollout-.+\.jsonl(?:\.zst)?$/;
const uuidPattern = /([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\.jsonl(?:\.zst)?$/i;
const relevant = /"type"\s*:\s*"(?:session_meta|turn_context|token_count|model_reroute|task_started|turn_started)"/;
const fields = ['input', 'output', 'cached', 'cacheWrite', 'reasoning', 'total'];
const chinese = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const MAX_ROWS = 25;
const SCAN_TTL = 55_000;

export function emptyUsage() {
  return { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function number(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function counters(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = number(raw.input_tokens);
  const output = number(raw.output_tokens);
  return {
    input,
    output,
    cached: number(raw.cached_input_tokens ?? raw.cache_read_input_tokens),
    cacheWrite: number(raw.cache_write_input_tokens),
    reasoning: number(raw.reasoning_output_tokens),
    total: number(raw.total_tokens) || input + output,
  };
}

function add(target, usage) {
  for (const key of fields) target[key] += usage[key];
}

function delta(total, previous) {
  if (!total || !previous) return null;
  const result = emptyUsage();
  for (const key of fields) {
    if (total[key] < previous[key]) return null;
    result[key] = total[key] - previous[key];
  }
  return result;
}

function measured(usage) {
  return usage && (usage.input > 0 || usage.output > 0);
}

function fingerprint(sample) {
  // Turn identifiers persist when a legacy fork rewrites the JSONL timestamps.
  return [sample.turnId, ...fields.map(key => sample.total?.[key]), ...fields.map(key => sample.last?.[key])].join('|');
}

function ownUsage(file, parent) {
  const uses = [];
  const parentEvents = parent && new Set(parent.samples.filter(event => event.turnId && (event.total || event.last)).map(fingerprint));
  const seen = new Set();
  let previous = null;
  let fallback = null;
  for (const event of file.samples) {
    const firstSnapshot = !previous;
    const change = delta(event.total, previous);
    if (event.total) previous = event.total;
    if (file.cutoff != null && event.ordinal != null && event.ordinal < file.cutoff) continue;
    if (file.forked && event.time && file.createdAt && event.time < file.createdAt) continue;
    if (parentEvents && event.turnId && parentEvents.has(fingerprint(event))) continue;
    if (event.quota && event.time && (!fallback || event.time > fallback.time)) fallback = { time: event.time, snapshot: event.quota };
    if (!event.time || (!event.total && !event.last)) continue;
    if (change && fields.every(key => change[key] === 0)) continue;
    if (!event.total) {
      const key = `${event.time}|${fingerprint(event)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }

    // A context-window estimate can carry only a total and resets the accumulator.
    // It is not a response. The next measured response establishes its own count.
    const usage = measured(event.last)
      ? (change && fields.every(key => change[key] >= event.last[key]) ? change : event.last)
      : (event.last ? null : (change ?? (firstSnapshot && !file.forked ? event.total : null)));
    if (measured(usage)) uses.push({ time: event.time, model: event.model, usage });
  }
  return { uses, fallback };
}

function newRollout(path) {
  return {
    path,
    filenameId: basename(path).match(uuidPattern)?.[1]?.toLowerCase() ?? null,
    id: null,
    createdAt: 0,
    cwd: null,
    cutoff: null,
    parentId: null,
    parentIds: [],
    forked: false,
    roots: [],
    nickname: '',
    activeModel: '',
    activeTurn: '',
    offset: 0,
    samples: [],
  };
}

function ingest(file, line) {
  if (!relevant.test(line.slice(0, 1024))) return;
  let record;
  try { record = JSON.parse(line); } catch { return; }
  const payload = record?.payload;
  if (!payload || typeof payload !== 'object') return;
  const event = record.type === 'event_msg' ? payload.type : record.type;
  if (event === 'session_meta') {
    if (typeof payload.id !== 'string' || (file.filenameId && payload.id !== file.filenameId) || (file.id && payload.id !== file.id)) return;
    file.id = payload.id;
    file.createdAt ||= Date.parse(payload.timestamp ?? record.timestamp) || 0;
    file.cwd ??= typeof payload.cwd === 'string' ? payload.cwd : null;
    if (!file.roots.length && Array.isArray(payload.runtime_workspace_roots)) {
      file.roots = payload.runtime_workspace_roots.filter(path => typeof path === 'string' && isAbsolute(path)).map(path => normalize(path));
    }
    file.parentId ??= payload.parent_thread_id ?? null;
    file.parentIds = [...new Set([...file.parentIds, payload.parent_thread_id, payload.forked_from_id, payload.history_base?.thread_id].filter(id => typeof id === 'string'))];
    file.forked ||= file.parentIds.length > 0;
    file.cutoff ??= payload.subagent_history_start_ordinal ?? payload.forked_from_ordinal_exclusive ?? payload.history_base?.end_ordinal_exclusive ?? null;
    file.nickname ||= label(payload.agent_nickname);
    file.activeModel ||= label(payload.model, 100);
  } else if (event === 'turn_context' || event === 'task_started' || event === 'turn_started') {
    file.activeTurn = label(payload.turn_id ?? payload.id) || file.activeTurn;
    file.activeModel = label(payload.model, 100) || file.activeModel;
  } else if (event === 'model_reroute') {
    file.activeModel = label(payload.to_model, 100) || file.activeModel;
  } else if (event === 'token_count') {
    const info = payload.info;
    const quota = payload.rate_limits;
    const t = Date.parse(record.timestamp) || 0;
    file.samples.push({
      time: t,
      ordinal: Number.isSafeInteger(record.ordinal) ? record.ordinal : null,
      turnId: label(payload.turn_id) || file.activeTurn,
      model: label(payload.model, 100) || file.activeModel,
      total: counters(info?.total_token_usage),
      last: counters(info?.last_token_usage),
      quota: quota && (!quota.limit_id || quota.limit_id === 'codex') ? quota : null,
    });
  }
}

async function readRollout(path, status, prior) {
  const compressed = path.endsWith('.zst');
  const signature = `${status.dev}:${status.ino}:${status.size}:${status.mtimeMs}:${status.ctimeMs}`;
  if (prior?.signature === signature) return prior;
  // Compaction and migration can replace/truncate a file. Append only on the same inode.
  const append = !compressed && prior && status.ino === prior.ino && status.dev === prior.dev && status.size > prior.size;
  const file = append ? { ...prior, samples: [...prior.samples] } : newRollout(path);
  if (status.size > file.offset) {
    const raw = createReadStream(path, { start: file.offset, end: status.size - 1, highWaterMark: 256 * 1024 });
    const unzip = compressed ? createZstdDecompress() : null;
    if (unzip) raw.on('error', error => unzip.destroy(error));
    const stream = unzip ? raw.pipe(unzip) : raw;
    let parts = [];
    let skip = false;
    let position = file.offset;
    try {
      for await (const chunk of stream) {
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline === -1 ? chunk.length : newline;
          const part = chunk.subarray(start, end);
          if (!skip) {
            if (!parts.length && part.length >= 1024 && !relevant.test(part.subarray(0, 1024).toString())) skip = true;
            else parts.push(part);
          }
          position += end - start + Number(newline !== -1);
          if (newline !== -1) {
            if (!skip && parts.length) ingest(file, Buffer.concat(parts).toString());
            parts = [];
            skip = false;
            file.offset = position;
          }
          start = end + Number(newline !== -1);
        }
      }
    } finally {
      raw.destroy();
    }
  }
  return { ...file, signature, ino: status.ino, dev: status.dev, size: status.size, mtime: status.mtimeMs };
}

async function discover(root, paths, errors) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') errors.add(root);
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await discover(path, paths, errors);
    else if (entry.isFile() && rolloutPattern.test(entry.name)) paths.add(path);
  }
}

function canonical(files, metadata) {
  const threads = new Map();
  for (const file of files) {
    const id = file.id || file.filenameId;
    if (!id) continue;
    const prior = threads.get(id);
    const recordedPath = metadata.threads.get(id)?.rollout_path;
    const isRecorded = file => file.path === recordedPath || file.path === `${recordedPath}.zst`;
    const rank = file => isRecorded(file) ? 1 : 0;
    if (!prior || rank(file) > rank(prior) || (rank(file) === rank(prior)
      && (file.samples.length > prior.samples.length || (file.samples.length === prior.samples.length && file.mtime > prior.mtime)))) {
      threads.set(id, { ...file, id });
    }
  }
  return threads;
}

function keyFormatter(timeZone) {
  try { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }); }
  catch { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
}

function aggregate(rollouts, metadata, formatter) {
  const days = new Map();
  const sessions = [];
  const projects = new Map();
  const models = new Map();
  const assignments = new Map();
  const threads = canonical(rollouts, metadata);
  const group = (map, id, name) => {
    if (!map.has(id)) map.set(id, { id, name, updatedAt: 0, usage: emptyUsage(), sessions: 0 });
    return map.get(id);
  };
  const assign = (file, visited = new Set()) => {
    if (assignments.has(file.id)) return assignments.get(file.id);
    if (file.parentId && !visited.has(file.id) && threads.has(file.parentId)) {
      visited.add(file.id);
      assign(threads.get(file.parentId), visited);
    }
    const project = projectFor(file, metadata, assignments);
    assignments.set(file.id, project);
    return project;
  };

  let quotaFallback = null;
  for (const file of threads.values()) {
    const parent = file.parentIds.map(id => threads.get(id)).find(Boolean);
    const { uses, fallback } = ownUsage(file, parent);
    if (fallback && (!quotaFallback || fallback.time > quotaFallback.time)) quotaFallback = fallback;
    if (!uses.length) continue;
    const project = assign(file);
    const projectRow = group(projects, project.id, project.name);
    const session = { id: file.id, name: sessionTitle(file, metadata), project: project.name, models: [], updatedAt: 0, usage: emptyUsage() };
    const modelsUsed = new Map();
    for (const { time, model, usage } of uses) {
      const date = formatter.format(time);
      days.set(date, (days.get(date) ?? 0) + usage.total);
      const modelId = model || '未知模型';
      const modelRow = group(models, modelId, modelId);
      if (!modelsUsed.has(modelId)) modelRow.sessions++;
      modelsUsed.set(modelId, (modelsUsed.get(modelId) ?? 0) + usage.total);
      modelRow.updatedAt = Math.max(modelRow.updatedAt, time);
      session.updatedAt = Math.max(session.updatedAt, time);
      add(session.usage, usage);
      add(modelRow.usage, usage);
    }
    session.models = [...modelsUsed].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    projectRow.sessions++;
    projectRow.updatedAt = Math.max(projectRow.updatedAt, session.updatedAt);
    add(projectRow.usage, session.usage);
    sessions.push(session);
  }
  return { days: [...days].sort(([a], [b]) => a.localeCompare(b)), sessions, projects: [...projects.values()], models: [...models.values()], quotaFallback };
}

export function queryRows(dataset, params = {}) {
  const scope = ['sessions', 'projects', 'models'].includes(params.scope) ? params.scope : 'sessions';
  const sort = ['updatedAt', 'name', ...fields].includes(params.sort) ? params.sort : 'total';
  const direction = params.direction === 'asc' ? 1 : -1;
  const query = label(params.query, 160).normalize('NFKC').toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
  const rows = dataset[scope].filter(row => {
    if (!query.length) return true;
    const text = [row.name, row.project, ...(row.models ?? [])].filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase('zh-CN');
    return query.every(part => text.includes(part));
  });
  rows.sort((a, b) => {
    const difference = sort === 'name' ? chinese.compare(a.name, b.name)
      : sort === 'updatedAt' ? a.updatedAt - b.updatedAt : a.usage[sort] - b.usage[sort];
    return direction * difference || b.updatedAt - a.updatedAt || chinese.compare(a.name, b.name) || a.id.localeCompare(b.id);
  });
  const offset = Math.max(0, Number.isSafeInteger(params.offset) ? params.offset : 0);
  return { rows: rows.slice(offset, offset + MAX_ROWS), totalRows: rows.length };
}

export class History {
  constructor(home, timeZone) {
    this.home = home;
    this.formatter = keyFormatter(timeZone);
    this.files = new Map();
    this.dataset = null;
    this.pending = null;
  }

  get(force = false) {
    if (this.pending) return this.pending;
    if (!force && this.dataset && Date.now() - this.dataset.updatedAt < SCAN_TTL) return Promise.resolve(this.dataset);
    this.pending = this.scan().finally(() => { this.pending = null; });
    return this.pending;
  }

  async scan() {
    const paths = new Set();
    const errors = new Set();
    const [metadata] = await Promise.all([
      readMetadata(this.home),
      ...['sessions', 'archived_sessions'].map(name => discover(join(this.home, name), paths, errors)),
    ]);
    const files = new Map();
    const entries = [...paths].filter(path => !path.endsWith('.zst') || !paths.has(path.slice(0, -4)));
    let index = 0;
    const scanNext = async () => {
      while (index < entries.length) {
        const path = entries[index++];
        const prior = this.files.get(path);
        try { files.set(path, await readRollout(path, await stat(path), prior)); }
        catch (error) {
          if (error.code !== 'ENOENT') {
            errors.add(path);
            if (prior) files.set(path, prior);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, scanNext));
    this.files = files;
    this.dataset = { ...aggregate(files.values(), metadata, this.formatter), updatedAt: Date.now(), partial: errors.size > 0 };
    return this.dataset;
  }
}
