import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { History, queryRows } from './lib/history.mjs';
import { Quota } from './lib/quota.mjs';

const version = '1.0.1';
const resourceUri = 'ui://codex-usage/dashboard.html';
const mimeType = 'text/html;profile=mcp-app';
const uiExtension = 'io.modelcontextprotocol/ui';
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const serverInfo = { name: 'codex-usage', title: 'Codex Usage', version };
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const history = new History(process.env.CODEX_HOME || join(homedir(), '.codex'), timeZone);
const quota = new Quota();
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const appOnly = { ui: { visibility: ['app'] } };
const icon = await readFile(new URL('./assets/icon.png', import.meta.url));
serverInfo.icons = [{ src: `data:image/png;base64,${icon.toString('base64')}`, mimeType: 'image/png', sizes: ['96x96'] }];

const tools = [
  {
    name: 'dashboard', title: 'Codex Usage', description: '打开 Codex 用量仪表盘',
    icons: serverInfo.icons,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    _meta: {
      ui: { resourceUri, visibility: ['app'] },
      'openai/ui': { entrypoints: [{ type: 'global' }] },
      'openai/outputTemplate': resourceUri,
    },
  },
  {
    name: 'usage_overview', title: '刷新用量', description: '读取仪表盘的本地用量与订阅额度',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean' } }, additionalProperties: false },
    annotations: { ...readOnly, openWorldHint: true }, _meta: appOnly,
  },
  {
    name: 'usage_rows', title: '查找用量明细', description: '分页读取仪表盘的用量明细',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        scope: { enum: ['sessions', 'projects', 'models'] },
        query: { type: 'string', maxLength: 160 },
        sort: { enum: ['name', 'updatedAt', 'input', 'output', 'cached', 'cacheWrite', 'reasoning', 'total'] },
        direction: { enum: ['asc', 'desc'] },
        offset: { type: 'integer', minimum: 0 },
      },
    },
    annotations: readOnly, _meta: appOnly,
  },
];

const resource = {
  uri: resourceUri, name: 'Codex Usage', mimeType,
  _meta: {
    ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false },
    'openai/ui': { availableDisplayModes: ['fullscreen', 'inline'], preferredDisplayMode: 'fullscreen' },
  },
};

let html;
async function renderResource() {
  if (html) return html;
  const [markup, style, bridge, app] = await Promise.all(['index.html', 'style.css', 'bridge.js', 'app.js']
    .map(file => readFile(new URL(`./ui/${file}`, import.meta.url), 'utf8')));
  html = markup.replace('<!-- STYLE -->', () => `<style>\n${style}\n</style>`)
    .replace('<!-- SCRIPT -->', () => `<script>\n${bridge}\n${app}\n</script>`);
  return html;
}

const capabilities = { tools: {}, resources: {}, extensions: { [uiExtension]: { mimeTypes: [mimeType] } } };
const failure = (code, message) => Object.assign(new Error(message), { code });
function privateResult(data) { return { content: [], _meta: { 'codex-usage/data': data } }; }

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25', capabilities, serverInfo };
    case 'ping': return {};
    case 'tools/list': return { tools };
    case 'resources/list': return { resources: [resource] };
    case 'resources/templates/list': return { resourceTemplates: [] };
    case 'resources/read':
      if (params.uri !== resourceUri) throw failure(-32002, 'Resource not found');
      return { contents: [{ ...resource, text: await renderResource() }] };
    case 'tools/call': {
      const args = params.arguments ?? {};
      if (params.name === 'dashboard') return { content: [] };
      if (params.name === 'usage_overview') {
        const data = await history.get(args.force === true);
        return privateResult({
          days: data.days,
          quota: await quota.get(data.quotaFallback, args.force === true),
          timeZone, updatedAt: data.updatedAt, partial: data.partial,
        });
      }
      if (params.name === 'usage_rows') return privateResult(queryRows(await history.get(), args));
      throw failure(-32602, 'Unknown tool');
    }
    default: throw failure(-32601, 'Method not found');
  }
}

function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
process.stdout.on('error', () => process.exit(0));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let message;
  try { message = JSON.parse(line); }
  catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
  if (message?.id === undefined) continue;
  handle(message.method, message.params ?? {}).then(
    result => send({ id: message.id, result }),
    error => send({ id: message.id, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: Number.isInteger(error.code) ? error.message : '请求失败' } }),
  );
}
