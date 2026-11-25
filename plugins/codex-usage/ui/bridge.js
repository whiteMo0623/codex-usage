'use strict';

// MCP Apps JSON-RPC transport. Data remains in the app-only tool result metadata.
class UsageBridge extends EventTarget {
  #next = 0;
  #requests = new Map();
  #connection = null;
  #origin = '*';
  #closed = false;

  constructor() {
    super();
    window.addEventListener('message', event => {
      if (event.source !== window.parent || (this.#origin !== '*' && event.origin !== this.#origin)) return;
      const message = event.data;
      if (message?.jsonrpc !== '2.0') return;
      if (message.method === 'ui/notifications/host-context-changed') {
        this.dispatchEvent(new CustomEvent('context', { detail: message.params ?? {} }));
      } else if (message.method === 'ui/resource-teardown') {
        if (message.id !== undefined) this.#send({ id: message.id, result: {} });
        this.#closed = true;
        for (const pending of this.#requests.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('仪表盘已关闭'));
        }
        this.#requests.clear();
        this.dispatchEvent(new Event('teardown'));
      } else if (message.method === 'ping' && message.id !== undefined) {
        this.#send({ id: message.id, result: {} });
      } else if (this.#requests.has(message.id)) {
        const pending = this.#requests.get(message.id);
        clearTimeout(pending.timer);
        this.#requests.delete(message.id);
        if (message.error) pending.reject(new Error('请求失败'));
        else {
          if (pending.method === 'ui/initialize' && event.origin !== 'null') this.#origin = event.origin;
          pending.resolve(message.result);
        }
      }
    });
  }

  #send(message) {
    window.parent.postMessage({ jsonrpc: '2.0', ...message }, this.#origin);
  }

  #request(method, params) {
    if (this.#closed) return Promise.reject(new Error('仪表盘已关闭'));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(id);
        reject(new Error('请求超时'));
      }, 16_000);
      this.#requests.set(id, { resolve, reject, timer, method });
      this.#send({ id, method, params });
    });
  }

  connect() {
    if (this.#connection) return this.#connection;
    if (window.parent === window) return Promise.reject(new Error('需要 Codex 桌面客户端'));
    this.#connection = this.#request('ui/initialize', {
      protocolVersion: '2026-01-26', appInfo: { name: 'Codex Usage', version: '1.0.1' },
      appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    }).then(result => {
      this.#send({ method: 'ui/notifications/initialized' });
      this.dispatchEvent(new CustomEvent('context', { detail: result?.hostContext ?? {} }));
    }).catch(error => {
      this.#connection = null;
      throw error;
    });
    return this.#connection;
  }

  async tool(name, args) {
    await this.connect();
    const result = await this.#request('tools/call', { name, arguments: args });
    const data = result?._meta?.['codex-usage/data'];
    if (result?.isError || !data) throw new Error('仪表盘数据不可用');
    return data;
  }
}
