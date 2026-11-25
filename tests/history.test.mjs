import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { History, queryRows } from '../plugins/codex-usage/lib/history.mjs';
import { Quota, quotaWindows } from '../plugins/codex-usage/lib/quota.mjs';

const first = '01910000-dead-4000-8000-000000000001';
const second = '01910000-dead-4000-8000-000000000002';
const third = '01910000-dead-4000-8000-000000000003';
const day1 = '2026-11-23T15:59:00.000Z';
const day2 = '2026-11-23T16:01:00.000Z';
const day3 = '2026-11-24T16:01:00.000Z';
const fileName = id => `rollout-2026-11-23T23-55-35-${id}.jsonl`;
const cwd = '/projects/workbench/frontend';
const meta = (id, timestamp, extra = {}) => ({ type: 'session_meta', timestamp, payload: { id, cwd, timestamp, ...extra } });
const ctx = (id, model, timestamp) => ({ type: 'turn_context', timestamp, payload: { turn_id: id, model } });
const tokens = (input, output, cache = 0, reasoning = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cache, reasoning_output_tokens: reasoning, total_tokens: input + output });
const usage = (time, total, last, ordinal, rate_limits) => ({ type: 'event_msg', timestamp: time, ordinal, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last }, rate_limits } });
const jsonl = entries => entries.map(entry => JSON.stringify(entry) + '\n').join('');

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'codex-usage-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const active = join(home, 'sessions', '2026', '11');
  const archive = join(home, 'archived_sessions');
  await Promise.all([mkdir(active, { recursive: true }), mkdir(archive)]);
  return { home, active, archive, history: new History(home, 'Asia/Shanghai') };
}

test('each response contributes once across days, projects, models and copied or rolled counters', async t => {
  const { home, active, archive, history } = await fixture(t);
  const source = join(active, fileName(first));
  const used = tokens(110, 27, 65, 8);
  const parent = [
    meta(first, day1), ctx('original', 'gpt-6.2-sol', day1),
    usage(day1, used, used),
    usage(day2, used, used), // a re-emitted cumulative snapshot at midnight
    ctx('next', 'gpt-6.2-astra', day2),
    usage(day2, tokens(170, 42, 85, 13), tokens(60, 15, 20, 5)),
    usage(day2, { total_tokens: 200_000 }, { total_tokens: 199_788 }), // context estimate
    usage(day2, tokens(50, 10, 10, 2), tokens(50, 10, 10, 2)), // restarted counters
  ];
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE projects(id TEXT, name TEXT); CREATE TABLE project_roots(project_id TEXT, path TEXT); CREATE TABLE threads(id TEXT, name TEXT, project_id TEXT, rollout_path TEXT);');
  db.prepare('INSERT INTO projects VALUES (?, ?)').run('work', '工作台');
  db.prepare('INSERT INTO project_roots VALUES (?, ?)').run('work', '/projects/workbench');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(first, '修复同步队列', 'work', source);
  db.close();
  const legacyFork = [
    meta(second, day2, { forked_from_id: first }), ctx('original', 'gpt-6.2-sol', day2),
    usage(day2, used, used), // same turn fingerprint, rewritten timestamp
    ctx('fork-new', 'gpt-6.2-sol', day3),
    usage(day3, tokens(130, 31, 70, 9), tokens(20, 4, 5, 1)),
  ];
  const paginatedChild = [
    meta(third, day2, { parent_thread_id: first, subagent_history_start_ordinal: 200, cwd: '/other/worktree' }),
    ctx('original', 'gpt-6.2-sol', day2), usage(day2, used, used, 42),
    ctx('child', 'gpt-6.2-astra', day3), usage(day3, tokens(40, 7, 10, 3), tokens(40, 7, 10, 3), 201),
  ];
  await Promise.all([
    writeFile(source, jsonl(parent)),
    writeFile(join(archive, fileName(first)), jsonl(parent)),
    writeFile(join(archive, fileName(second) + '.zst'), zstdCompressSync(Buffer.from(jsonl(legacyFork)))),
    writeFile(join(active, fileName(third)), jsonl(paginatedChild)),
  ]);
  const data = await history.get();
  assert.equal(data.partial, false);
  assert.equal(data.sessions.length, 3);
  assert.deepEqual(data.days, [['2026-11-23', 137], ['2026-11-24', 135], ['2026-11-25', 71]]);
  assert.deepEqual(data.projects.map(row => [row.name, row.sessions, row.usage.total]), [['工作台', 3, 343]]);
  assert.equal(data.sessions.find(row => row.id === first).usage.reasoning, 15);
  assert.equal(data.models.find(row => row.name === 'gpt-6.2-sol').usage.total, 161);
  assert.equal(data.models.find(row => row.name === 'gpt-6.2-astra').usage.total, 182);
  assert.equal(queryRows(data, { query: '修复 ＧＰＴ-６.２-ＳＯＬ' }).rows[0].id, first);
  assert.equal(queryRows(data, { sort: 'input', direction: 'asc' }).rows[0].id, second);
});

test('refresh resumes at the first incomplete UTF-8 line and handles file replacement or archive', async t => {
  const { active, archive, history } = await fixture(t);
  const path = join(active, fileName(first));
  const start = jsonl([meta(first, day1), ctx('a', '模型 A', day1), usage(day1, tokens(90, 10), tokens(90, 10))]);
  const rest = Buffer.from(jsonl([ctx('b', '模型 B', day2), usage(day2, tokens(95, 15), tokens(5, 5))]));
  const cut = rest.indexOf(Buffer.from('型')) + 1;
  await writeFile(path, start);
  await appendFile(path, rest.subarray(0, cut));
  assert.equal((await history.get()).sessions[0].usage.total, 100);
  await appendFile(path, rest.subarray(cut));
  let data = await history.get(true);
  assert.equal(data.sessions[0].usage.total, 110);
  assert.equal(data.models.find(row => row.name === '模型 B').usage.total, 10);
  const archived = join(archive, fileName(first));
  await rename(path, archived);
  assert.equal((await history.get(true)).sessions[0].usage.total, 110);
  await writeFile(archived, start);
  data = await history.get(true);
  assert.deepEqual(data.days, [['2026-11-23', 100]]);
});

test('a cumulative-only legacy record can supply measured deltas', async t => {
  const { active, history } = await fixture(t);
  await writeFile(join(active, fileName(first)), jsonl([
    meta(first, day1), ctx('a', 'model-legacy', day1), usage(day1, tokens(100, 10, 55, 6)),
    usage(day2, tokens(130, 22, 60, 10)), usage(day3, tokens(130, 22, 60, 10)),
  ]));
  const data = await history.get();
  assert.deepEqual(data.days, [['2026-11-23', 110], ['2026-11-24', 42]]);
  assert.deepEqual(data.sessions[0].usage, { input: 130, output: 22, cached: 60, cacheWrite: 0, reasoning: 10, total: 152 });
});

test('row queries page in stable order and preserve distinct dimensions', () => {
  const sessions = Array.from({ length: 35 }, (_, i) => ({ id: String(i), name: `会话 ${i}`, project: '性能', models: ['alpha'], updatedAt: i, usage: { total: 100 } }));
  assert.equal(queryRows({ sessions }, { sort: 'name', direction: 'asc', offset: 25 }).rows[0].id, '25');
  assert.equal(queryRows({ sessions }, { query: '性能 alpha 34' }).totalRows, 1);
  assert.equal(queryRows({ sessions }, {}).rows[0].id, '34');
});

test('quota identifies durations, ignores other buckets, and only falls back on read errors', async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const past = Math.floor(Date.now() / 1000) - 10;
  const log = { time: Date.now(), snapshot: { primary: { window_minutes: 300, used_percent: 17.5, resets_at: future }, secondary: { window_minutes: 10080, used_percent: 50, resets_at: past } } };
  let fail = false;
  let count = 0;
  const service = new Quota(async () => {
    count++;
    if (fail) throw new Error('timeout');
    return { rateLimitsByLimitId: { codex: { primary: { windowDurationMins: 10080, usedPercent: 24, resetsAt: future } }, other: { primary: { windowDurationMins: 300, usedPercent: 2 } } } };
  });
  assert.deepEqual(quotaWindows({ primary: { windowDurationMins: 300, usedPercent: 108 } }), { fiveHours: { remaining: 0, resetsAt: null }, weekly: null });
  const [official] = await Promise.all([service.get(log), service.get(log)]);
  assert.equal(count, 1);
  assert.equal(official.windows.fiveHours, null);
  assert.equal(official.windows.weekly.remaining, 76);
  fail = true;
  const cached = await service.get(null, true);
  assert.equal(cached.stale, true);
  assert.equal(cached.windows.weekly.remaining, 76);
  const fallback = await new Quota(async () => { throw new Error('offline'); }).get(log);
  assert.deepEqual(fallback.windows, { fiveHours: { remaining: 82.5, resetsAt: future * 1000 }, weekly: null });
});
