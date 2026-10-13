'use strict';
// Local ZCode app-server fixture: no ZCode CLI, credentials, network or model
// calls. Speaks the bare JSON-RPC line protocol the ARM client uses and plays
// the MCP record_review path by dialing the relay port from session/create.
const net = require('node:net');
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const sessionId = `sess-${process.pid}`;
let turnId = null, relay = null, relayToken = null, wire = null, connected = false;
let queue = [], completion = null, callId = 0, done = false, answers = Promise.resolve();

function relayCall(review) {
  const id = `fixture-${++callId}`;
  return new Promise(resolve => {
    const onLine = line => {
      let answer; try { answer = JSON.parse(line); } catch { return; }
      if (answer.id === id) { wire.off('line', onLine); resolve(answer); }
    };
    wire.on('line', onLine);
    relay.write(JSON.stringify({ id, token: relayToken, kind: 'record_review', arguments: review }) + '\n');
  });
}
function flush() {
  if (!connected) return;
  const reviews = queue.splice(0);
  if (reviews.length) answers = answers.then(() => Promise.all(reviews.map(relayCall)));
  answers.then(() => {
    if (done || !completion || queue.length) return;
    done = true;
    send({ method: 'session/event', params: { sessionId, type: completion === 'completed' ? 'turn.completed' : 'turn.failed', turnId,
      payload: completion === 'completed' ? { response: 'fixture', tokenCount: 0, toolCallCount: callId, duration: 0 } : { error: { type: 'unknown_error', message: 'fixture failure' } } } });
  }, () => process.exit(1));
}
function dial(port, token) {
  relayToken = token;
  relay = net.connect({ port, host: '127.0.0.1' });
  relay.on('error', () => {});
  wire = readline.createInterface({ input: relay });
  wire.on('error', () => {});
  relay.on('connect', () => { connected = true; flush(); });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (!frame.method) return;
  if (frame.method === 'session/create') {
    const server = frame.params.mcpServers?.[0];
    const port = Number(server?.args?.[server.args.length - 2]), token = server?.args?.[server.args.length - 1];
    if (port && token) dial(port, token);
    send({ id: frame.id, result: { session: { sessionId } } });
  }
  if (frame.method === 'session/subscribe') send({ id: frame.id, result: { sessionId, eventSeq: 0 } });
  if (frame.method === 'session/send') {
    turnId = `turn-${process.pid}`;
    send({ method: 'session/event', params: { sessionId, type: 'turn.started', turnId } });
    send({ id: frame.id, result: { accepted: true, sessionId, stateRevision: 2 } });
    process.send({ type: 'turn', pid: process.pid, input: frame.params });
    flush();
  }
  if (frame.method === 'session/stop') send({ id: frame.id, result: { stopped: true } });
  if (frame.method === 'session/close') { send({ id: frame.id, result: {} }); process.exit(0); }
});
process.on('message', message => { queue.push(...(message.reviews || [])); completion = message.status || 'completed'; flush(); });
process.stdin.on('end', () => process.exit(0));
process.on('disconnect', () => process.exit(0));
