'use strict';
// An opt-in wire audit of the installed CLI. Only localhost receives requests;
// every response deliberately fails before any model or tool can run.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { testTempRoot, testOutput } = require('./support.cjs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AppServer } = require('../src/app-server.cjs');

test('installed app-server exposes only record_review and preserves original image detail without project context',
  { skip: !process.env.ARM_TEST_CODEX_EXE, timeout: 30000 }, async t => {
    const root = fs.mkdtempSync(path.join(testTempRoot(), 'arm-cli-isolation-'));
    const cwd = path.join(root, 'images'); fs.mkdirSync(cwd);
    const sentinel = 'ARM_PROJECT_CONTEXT_MUST_NOT_LEAK';
    fs.writeFileSync(path.join(root, 'AGENTS.md'), sentinel);
    const skill = path.join(root, '.agents', 'skills', 'ambient-fixture'); fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: ambient-fixture\ndescription: ${sentinel}\n---\n${sentinel}`);
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        if (req.method === 'POST') requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Offline audit only', type: 'invalid_request_error' } }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await app.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const image = path.join(cwd, 'current.png');
    fs.copyFileSync(path.resolve(__dirname, '../public/assets/astronaut.png'), image);
    let stderr = '';
    const app = new AppServer({ codex: process.env.ARM_TEST_CODEX_EXE, spawnFn(command, args, config) {
      args.unshift('-c', 'model_provider="audit_mock"', '-c', `model_providers.audit_mock={name="Audit mock",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false}`);
      return spawn(command, args, config);
    } });
    const session = app.review({ generation: 1, cwd, prompt: 'Offline QA fixture: inspect only the attached current.png.', files: [{ name: 'current.png' }], onIdentity() {}, onReview() { throw new Error('No model calls allowed'); }, onLog: text => { stderr += text; } });
    await new Promise(resolve => session.once('close', resolve));
    if (!requests.length) console.error('Audit startup failure:', session.failure?.message, stderr);
    assert.equal(requests.length, 1, stderr);
    const request = requests[0], context = JSON.stringify(request.input);
    const additional = (request.input || []).filter(item => item.type === 'additional_tools');
    assert.equal(request.model, 'gpt-5.6-sol');
    const tools = [...(request.tools || []), ...additional.flatMap(item => item.tools || [])];
    assert.deepEqual(tools.map(tool => tool.name), ['record_review'], `Unexpected tools: ${JSON.stringify(tools)}`);
    assert.deepEqual(Object.keys(tools[0].parameters.properties).sort(), ['issues', 'name', 'sha256', 'status']);
    // User-scope AGENTS.md remains authoritative; only project context is excluded.
    assert.ok(!context.includes(sentinel), 'Project AGENTS.md or skill leaked into model context');
    for (const marker of ['<skills_instructions>', '<recommended_plugins>', 'MEMORY_SUMMARY BEGINS']) assert.ok(!context.includes(marker), `${marker} leaked`);
    assert.ok(!context.includes('multi_agent_role'), 'Multi-agent instructions leaked');
    assert.ok(!JSON.stringify(additional).match(/spawn_agent|followup_task|send_message|apply_patch|exec_command|view_image/), JSON.stringify(additional));
    // CLI may transcode the attached PNG into JPEG for its image transport.
    assert.equal((context.match(/data:image\/(?:png|jpeg|webp);base64/g) || []).length, 1);
    const images = request.input.flatMap(item => Array.isArray(item.content) ? item.content.filter(c => c.type === 'input_image') : []);
    assert.equal(images[0].detail, 'original');
  });
