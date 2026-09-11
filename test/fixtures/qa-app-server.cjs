'use strict';
// Local JSON-RPC process fixture: no Codex, credentials, network or model calls.
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const threadId = `thread-${process.pid}`, turnId = `turn-${process.pid}`;
let callId = 1000, pending = [], completion;
function next() {
  if (pending.length) send({ id: ++callId, method: 'item/tool/call', params: { threadId, turnId, callId: String(callId), tool: 'record_review', arguments: pending.shift() } });
  else if (completion) send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: completion } } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (!frame.method) { if (frame.result?.success) next(); return; }
  if (frame.method === 'initialize') send({ id: frame.id, result: {} });
  if (frame.method === 'config/read') send({ id: frame.id, result: { config: {} } });
  if (frame.method === 'thread/start') send({ id: frame.id, result: { thread: { id: threadId } } });
  if (frame.method === 'turn/start') {
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
    send({ id: frame.id, result: { turn: { id: turnId } } });
    process.send({ type: 'turn', pid: process.pid, input: frame.params.input });
  }
});
process.on('message', message => { pending = message.reviews || []; completion = message.status; next(); });
process.stdin.on('end', () => process.exit(0));
process.on('disconnect', () => process.exit(0));
