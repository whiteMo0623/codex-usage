import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('stdio exposes an app-only global entrypoint with a self-contained MCP resource', async t => {
  const home = await mkdtemp(join(tmpdir(), 'codex-usage-mcp-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const server = fileURLToPath(new URL('../plugins/codex-usage/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [server], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  async function request(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
    const response = JSON.parse((await lines.next()).value);
    assert.equal(response.id, id);
    return response;
  }
  assert.equal((await request('server/discover')).error.code, -32601);
  const hello = await request('initialize', { protocolVersion: '2025-11-25' });
  assert.equal(hello.result.protocolVersion, '2025-11-25');
  assert.equal(hello.result.serverInfo.name, 'codex-usage');
  const { tools } = (await request('tools/list')).result;
  assert.equal(tools.length, 3);
  assert.ok(tools.every(tool => tool._meta.ui.visibility.join() === 'app'));
  const dashboard = tools.find(tool => tool.name === 'dashboard');
  assert.deepEqual(dashboard._meta['openai/ui'].entrypoints, [{ type: 'global' }]);
  const uri = dashboard._meta.ui.resourceUri;
  const opened = await request('tools/call', { name: dashboard.name, arguments: {} });
  assert.deepEqual(opened.result, { content: [] });
  const resource = (await request('resources/read', { uri })).result.contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(resource._meta.ui.csp.connectDomains, []);
  assert.deepEqual(resource._meta.ui.csp.resourceDomains, []);
  assert.match(resource.text, /<html lang="zh-CN">/);
  assert.match(resource.text, /ui\/initialize/);
  assert.doesNotMatch(resource.text, /<(?:script|link)\s[^>]*(?:src|href)=/);
  const rows = (await request('tools/call', { name: 'usage_rows', arguments: {} })).result;
  assert.deepEqual(rows.content, []);
  assert.deepEqual(rows._meta['codex-usage/data'], { rows: [], totalRows: 0 });
  child.stdin.end();
});
