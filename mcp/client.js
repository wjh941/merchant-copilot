// 最小 MCP stdio 客户端（零依赖）：spawn mcp-server.js 子进程，按行读写 JSON-RPC。
'use strict';
const { spawn } = require('child_process');
const path = require('path');

class McpClient {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.buffer = '';
    this.tools = [];
  }

  start() {
    this.proc = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'mcp-server.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', d => process.stderr.write('[mcp-server] ' + d));
    this.proc.on('exit', code => {
      for (const { reject } of this.pending.values()) reject(new Error('MCP server 退出, code=' + code));
      this.pending.clear();
    });
  }

  rpc(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('MCP 调用超时: ' + method)); }
      }, 15000);
    });
  }

  async init() {
    this.start();
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'merchant-copilot-agent', version: '0.1.0' },
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const { tools } = await this.rpc('tools/list', {});
    this.tools = tools;
    return tools;
  }

  async callTool(name, args) {
    const result = await this.rpc('tools/call', { name, arguments: args || {} });
    const text = result.content && result.content[0] && result.content[0].text || '';
    if (result.isError) throw new Error(text);
    try { return JSON.parse(text); } catch { return text; }
  }

  stop() { if (this.proc) this.proc.kill(); }
}

module.exports = { McpClient };
