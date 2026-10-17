'use strict';
// MCP stdio server spawned once per builder session by the ZCode app-server.
// It exposes exactly two tools: save_document persists the assembled step 3
// document and read_file pages staged source material. Both relay every call
// synchronously to the ARM backend over a loopback TCP line protocol, so the
// backend validates and durably commits before this process acknowledges the
// call back to the model. argv: <relayPort> <relayToken>.
const net = require('node:net');
const readline = require('node:readline');

const port = Number(process.argv[2]);
const token = process.argv[3];
const relayTimeoutMs = Number(process.env.ARM_BUILD_RELAY_TIMEOUT_MS || 120000);
if (!Number.isInteger(port) || port < 1 || !token) { console.error('builder-bridge: relay port and token are required'); process.exit(2); }

const SAVE_DOCUMENT = Object.freeze({
  name: 'save_document',
  description: 'Сохранить собранный документ новой страницы. Единственная операция записи.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['revision', 'document'],
    properties: {
      revision: { type: 'integer', minimum: 1 },
      document: { type: 'object' },
    },
  },
});
const READ_FILE = Object.freeze({
  name: 'read_file',
  description: 'Прочитать фрагмент разрешённого файла staging по белому списку.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['name'],
    properties: {
      name: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      length: { type: 'integer', minimum: 1 },
    },
  },
});

// Loopback wire: one JSON object per line. Request {id, token, kind,
// arguments}; response {id, accepted, ...} or {id, error}.
const wire = net.connect({ port, host: '127.0.0.1' });
wire.on('error', error => { console.error(`builder-bridge: relay: ${error.message}`); process.exit(1); });
wire.on('close', () => process.exit(1));
const pending = new Map();
let serial = 0;
const wireReader = readline.createInterface({ input: wire });
wireReader.on('error', () => {});
wireReader.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const entry = pending.get(message.id);
  if (entry) { pending.delete(message.id); entry(message); }
});
function relay(kind, arguments_) {
  const id = `c${++serial}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('ARM backend relay timeout')); }, relayTimeoutMs);
    pending.set(id, answer => { clearTimeout(timer); answer.error ? reject(new Error(String(answer.error))) : resolve(answer); });
    wire.write(JSON.stringify({ id, token, kind, arguments: arguments_ }) + '\n');
  });
}

const stdinReader = readline.createInterface({ input: process.stdin });
stdinReader.on('error', () => {});
stdinReader.on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (!Object.hasOwn(message, 'id')) return; // client notifications are stateless here
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'reestr35-builder-bridge', version: '1.0.0' } } });
  } else if (message.method === 'tools/list') {
    send({ id: message.id, result: { tools: [SAVE_DOCUMENT, READ_FILE] } });
  } else if (message.method === 'tools/call') {
    let arguments_;
    try { arguments_ = JSON.parse(message.params?.arguments ?? 'null') ?? message.params?.arguments; } catch { arguments_ = message.params?.arguments; }
    if (typeof arguments_ !== 'object' || arguments_ === null) { send({ id: message.id, result: { content: [{ type: 'text', text: `${message.params?.name} requires an arguments object` }], isError: true } }); return; }
    try {
      const answer = await relay(message.params?.name, arguments_);
      send({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(answer) }] } });
    } catch (error) {
      send({ id: message.id, result: { content: [{ type: 'text', text: `${message.params?.name} rejected: ${error.message}` }], isError: true } });
    }
  } else {
    // The client first probes server/discover (its stdio multiplexing
    // extension); refusing it makes the client fall back to plain MCP.
    send({ id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
  }
});
// Strict JSON-RPC 2.0 envelopes: the client rejects responses without jsonrpc.
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); }
process.stdin.on('end', () => process.exit(0));
