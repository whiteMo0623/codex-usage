import { readFile, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';

export function label(value, max = 180) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

async function readState(home) {
  const names = (await readdir(home).catch(() => []))
    .filter(name => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!names.length) return { threads: new Map(), roots: [], projects: new Map() };

  const { DatabaseSync } = await import('node:sqlite');
  for (const name of names) {
    let db;
    try {
      db = new DatabaseSync(join(home, name), { readOnly: true });
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
      if (!columns.has('id')) continue;
      const fields = ['id', 'name', 'title', 'cwd', 'rollout_path', 'project_id'];
      const rows = db.prepare(`SELECT ${fields.map(field => columns.has(field) ? field : `NULL AS ${field}`).join(', ')} FROM threads`).all();
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
      const projects = new Map(tables.has('projects')
        ? db.prepare('SELECT id, name FROM projects').all().map(row => [row.id, label(row.name)])
        : []);
      const roots = tables.has('project_roots') ? db.prepare('SELECT project_id, path FROM project_roots').all()
        .filter(row => typeof row.path === 'string' && isAbsolute(row.path) && projects.has(row.project_id))
        .map(row => ({ id: row.project_id, path: normalize(row.path) }))
        .sort((a, b) => b.path.length - a.path.length) : [];
      return { threads: new Map(rows.map(row => [row.id, row])), roots, projects };
    } catch {
      // A concurrently migrated database may briefly be unavailable.
    } finally {
      db?.close();
    }
  }
  return { threads: new Map(), roots: [], projects: new Map() };
}

export async function readMetadata(home) {
  const [state, index] = await Promise.all([
    readState(home).catch(() => ({ threads: new Map(), roots: [], projects: new Map() })),
    readFile(join(home, 'session_index.jsonl'), 'utf8').catch(() => ''),
  ]);
  const titles = new Map();
  for (const line of index.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const name = label(row.thread_name);
      if (!name || typeof row.id !== 'string') continue;
      const time = Date.parse(row.updated_at) || 0;
      if (!titles.has(row.id) || time >= titles.get(row.id).time) titles.set(row.id, { name, time });
    } catch {
      // Codex can append a record while the index is being read.
    }
  }
  return { ...state, titles };
}

function contains(root, path) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function projectFor(rollout, meta, assignments) {
  const row = meta.threads.get(rollout.id);
  const id = row?.project_id;
  const cwd = [row?.cwd, rollout.cwd].find(path => typeof path === 'string' && isAbsolute(path));
  const matching = meta.roots.find(root => [cwd, ...rollout.roots].some(path => path && contains(root.path, normalize(path))));
  const ownProject = meta.projects.has(id) ? id : matching?.id;
  if (ownProject != null) {
    return { id: `project:${ownProject}`, name: meta.projects.get(ownProject) || '未命名项目' };
  }

  const parent = assignments.get(rollout.parentId);
  if (parent) return parent;
  const workspace = rollout.roots.find(root => cwd && contains(root, normalize(cwd))) ?? cwd;
  if (!workspace) return { id: 'ungrouped', name: '无项目' };
  const path = normalize(workspace);
  return { id: `path:${path}`, name: basename(path) || path };
}

export function sessionTitle(rollout, meta) {
  const row = meta.threads.get(rollout.id);
  return label(row?.name) || meta.titles.get(rollout.id)?.name || label(row?.title) || label(rollout.nickname) || '未命名会话';
}
