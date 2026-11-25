import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const bundledCli = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const cacheTime = 58_000;
const windows = [['fiveHours', 300], ['weekly', 10_080]];

export function quotaWindows(snapshot) {
  const values = [snapshot?.primary, snapshot?.secondary].filter(Boolean);
  return Object.fromEntries(windows.map(([name, minutes]) => {
    const value = values.find(window => (window.windowDurationMins ?? window.window_minutes) === minutes);
    const used = value?.usedPercent ?? value?.used_percent;
    const reset = value?.resetsAt ?? value?.resets_at;
    return [name, Number.isFinite(used) ? {
      remaining: Math.max(0, Math.min(100, 100 - used)),
      resetsAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
    } : null];
  }));
}

async function cliPath() {
  try { await access(bundledCli, constants.X_OK); return bundledCli; }
  catch { return 'codex'; }
}

export async function readAccountQuota() {
  const command = await cliPath();
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server', '--stdio', '--disable', 'plugins', '-c', 'analytics.enabled=false'], {
      cwd: '/tmp', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    const deadline = setTimeout(() => finish(new Error('Quota request timed out')), 9_000);
    let complete = false;
    let stopTimer;

    function finish(error, response) {
      if (complete) return;
      complete = true;
      clearTimeout(deadline);
      lines.close();
      child.stdin.end();
      if (child.exitCode == null && child.signalCode == null) {
        stopTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
        stopTimer.unref();
      }
      if (error) reject(error);
      else resolve(response);
    }
    function send(value) { child.stdin.write(JSON.stringify(value) + '\n'); }

    child.once('error', finish);
    child.once('exit', () => clearTimeout(stopTimer));
    child.stdout.once('end', () => finish(new Error('Codex App Server closed its output')));
    child.stdin.on('error', finish);
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1 && message.result) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (message.id === 1 || message.id === 2) {
        if (message.error || !message.result) return finish(new Error('Codex quota unavailable'));
        finish(null, message.result);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_usage', title: 'Codex Usage', version: '1.0.1' } } });
  });
}

export class Quota {
  constructor(read = readAccountQuota) {
    this.read = read;
    this.current = null;
    this.lastAttempt = 0;
    this.failed = false;
    this.pending = null;
  }

  async get(fallback, force) {
    if (!this.pending && (force || Date.now() - this.lastAttempt >= cacheTime)) {
      this.lastAttempt = Date.now();
      this.pending = this.read().then(result => {
        const legacy = result.rateLimits;
        const snapshot = result.rateLimitsByLimitId?.codex ?? (legacy?.limitId == null || legacy.limitId === 'codex' ? legacy : null);
        this.current = { windows: quotaWindows(snapshot), observedAt: Date.now() };
        this.failed = false;
      }).catch(() => { this.failed = true; }).finally(() => { this.pending = null; });
    }
    await this.pending;
    if (!this.failed) return { ...this.current, stale: false };
    const latest = fallback && (!this.current || fallback.time > this.current.observedAt)
      ? { windows: quotaWindows(fallback.snapshot), observedAt: fallback.time }
      : this.current;
    if (!latest) return { windows: quotaWindows(null), observedAt: null, stale: false };
    const now = Date.now();
    const valid = Object.fromEntries(Object.entries(latest.windows).map(([key, value]) => [key, value?.resetsAt > now ? value : null]));
    return { windows: valid, observedAt: latest.observedAt, stale: true };
  }
}
