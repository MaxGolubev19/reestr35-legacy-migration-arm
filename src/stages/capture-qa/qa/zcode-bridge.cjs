'use strict';
// MCP stdio server spawned once per QA session by the ZCode app-server. It
// exposes exactly one tool, record_review, and relays every call synchronously
// to the ARM backend over a loopback TCP line protocol. The backend validates
// the review and durably checkpoints it before this process acknowledges the
// call back to the model. argv: <relayPort> <relayToken>.
const net = require('node:net');
const readline = require('node:readline');

const port = Number(process.argv[2]);
const token = process.argv[3];
const relayTimeoutMs = Number(process.env.ARM_QA_RELAY_TIMEOUT_MS || 120000);
if (!Number.isInteger(port) || port < 1 || !token) { console.error('zcode-bridge: relay port and token are required'); process.exit(2); }

const RECORD_REVIEW = Object.freeze({
  name: 'record_review',
  description: 'Immediately persist the visual review of the next attached PNG in order.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['name', 'sha256', 'status', 'issues'],
    properties: {
      name: { type: 'string' },
      sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      status: { type: 'string', enum: ['passed', 'issues'] },
      issues: { type: 'array', items: { type: 'string' } },
    },
  },
});

// Loopback wire: one JSON object per line. Request {id, token, kind,
// arguments}; response {id, accepted, ...} or {id, error}.
const wire = net.connect({ port, host: '127.0.0.1' });
wire.on('error', error => { console.error(`zcode-bridge: relay: ${error.message}`); process.exit(1); });
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
function relay(arguments_) {
  const id = `c${++serial}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('ARM backend relay timeout')); }, relayTimeoutMs);
    pending.set(id, answer => { clearTimeout(timer); answer.error ? reject(new Error(String(answer.error))) : resolve(answer); });
    wire.write(JSON.stringify({ id, token, kind: 'record_review', arguments: arguments_ }) + '\n');
  });
}

const stdinReader = readline.createInterface({ input: process.stdin });
stdinReader.on('error', () => {});
stdinReader.on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (!Object.hasOwn(message, 'id')) return; // client notifications are stateless here
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'reestr35-qa-bridge', version: '1.0.0' } } });
  } else if (message.method === 'tools/list') {
    send({ id: message.id, result: { tools: [RECORD_REVIEW] } });
  } else if (message.method === 'tools/call') {
    let arguments_;
    try { arguments_ = JSON.parse(message.params?.arguments ?? 'null') ?? message.params?.arguments; } catch { arguments_ = message.params?.arguments; }
    if (typeof arguments_ !== 'object' || arguments_ === null) { send({ id: message.id, result: { content: [{ type: 'text', text: 'record_review requires an arguments object' }], isError: true } }); return; }
    try {
      const answer = await relay(arguments_);
      send({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(answer) }] } });
    } catch (error) {
      send({ id: message.id, result: { content: [{ type: 'text', text: `record_review rejected: ${error.message}` }], isError: true } });
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
