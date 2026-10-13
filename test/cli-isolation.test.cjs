'use strict';
// An opt-in wire audit of the installed ZCode CLI. Only localhost receives
// requests; every response deliberately fails before any model or tool can run.
// The built-in provider catalog is copied with one extra provider-site rule so
// the audit endpoint resolves the same image capability production gets from
// the real api.z.ai rule; nothing outside the temp directory is modified.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { testTempRoot } = require('./support.cjs');
const { AppServer } = require('../src/app-server.cjs');
const { personalProviderFile, discoverBuiltinProviderConfig, BRIDGE } = require('../src/stages/capture-qa/qa/config.cjs');
const { resolveRuntime } = require('../src/lib.cjs');

function auditBuiltinConfig(root, port) {
  const catalog = JSON.parse(fs.readFileSync(discoverBuiltinProviderConfig(process.env), 'utf8'));
  catalog.config.modelConfigRules.providerSiteRules.push({
    modelMatch: '.*',
    baseUrlMatch: `http://127\\.0\\.0\\.1:${port}/api/anthropic`,
    apiTypeMatch: 'anthropic-messages',
    config: { properties: { inputFormat: { supportsImage: true, supportsVideo: false, supportsPdf: false } } },
  });
  const file = path.join(root, 'zcode-builtin-audit.json');
  fs.writeFileSync(file, JSON.stringify(catalog));
  return file;
}

test('installed app-server exposes only record_review and preserves original image detail without project context',
  { skip: !process.env.ARM_TEST_ZCODE_CJS, timeout: 90000 }, async t => {
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
        if (req.method === 'POST') requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Offline audit only' } }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const launch = { node: process.env.ARM_TEST_ZCODE_NODE || resolveRuntime().node, script: process.env.ARM_TEST_ZCODE_CJS, bridge: BRIDGE,
      provider: 'custom:audit-provider', model: process.env.ARM_TEST_ZCODE_MODEL || 'GLM-5.3', reasoning: 'low',
      apiBase: `http://127.0.0.1:${server.address().port}/api/anthropic`, apiKey: 'offline-audit-key',
      builtinProviderConfig: process.env.ARM_TEST_ZCODE_BUILTIN_CONFIG || auditBuiltinConfig(root, server.address().port) };
    launch.personalProviderFile = personalProviderFile(root, launch);
    const app = new AppServer({ launch, root });
    t.after(async () => { await app.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const image = path.join(cwd, 'current.png');
    fs.copyFileSync(path.resolve(__dirname, '../public/assets/astronaut.png'), image);
    // The QA staging dir always shadows parent instructions with its own AGENTS.md.
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'Temporary QA staging directory. No project instructions.\n');
    let stderr = '';
    const session = app.review({ generation: 1, cwd, prompt: 'Offline QA fixture: inspect only the attached current.png.', files: [{ name: 'current.png' }],
      onIdentity() {}, onReview() { throw new Error('No model calls allowed'); }, onLog: text => { stderr += text; } });
    await new Promise(resolve => session.once('close', resolve));
    const modelRequests = requests.filter(request => request.url.endsWith('/v1/messages'));
    if (!modelRequests.length) console.error('Audit startup failure:', session.failure?.message, stderr);
    assert.ok(modelRequests.length >= 1, stderr);
    const request = modelRequests[0].body, context = JSON.stringify(request.messages || []) + JSON.stringify(request.system || '');
    assert.equal(request.model, launch.model);
    assert.deepEqual((request.tools || []).map(tool => tool.name), ['mcp__reestr35-qa__record_review'], `Unexpected tools: ${JSON.stringify(request.tools)}`);
    assert.deepEqual(Object.keys(request.tools[0].input_schema.properties).sort(), ['issues', 'name', 'sha256', 'status']);
    // User-scope configuration remains authoritative; only project context is excluded.
    assert.ok(!context.includes(sentinel), 'Project AGENTS.md or skill leaked into model context');
    assert.ok(context.includes('Temporary QA staging directory'), 'Staged AGENTS.md did not shadow the workspace');
    assert.ok(!JSON.stringify(request.tools).match(/spawn_agent|followup_task|send_message|apply_patch|exec_command|view_image/), JSON.stringify(request.tools));
    assert.ok(context.includes('Offline QA fixture'), 'ARM prompt did not reach the model');
    // The attached PNG must arrive unscaled as one base64 image block.
    const images = (request.messages || []).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : []);
    assert.equal(images.length, 1);
    const source = images[0].source || {};
    assert.equal(source.type, 'base64', JSON.stringify(source).slice(0, 200));
    assert.equal(source.media_type, 'image/png');
    const expected = fs.readFileSync(image).toString('base64');
    assert.equal(source.data, expected, 'image payload was transcoded or rescaled');
  });
