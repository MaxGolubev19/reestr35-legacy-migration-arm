'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { createSshTransport, sshCommand } = require('../src/stages/beget/ssh.cjs');
const config = { host: 'ssh.example.test', user: 'account', port: 22, identityFile: path.resolve('personal key'),
  remoteScript: "/home/account/a'b site/rest/arm_sync.php", phpBinary: 'php7.4' };
const mock = script => (command, args, options) => spawn(process.execPath, ['-e', script], options);
const read = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{";

test('SSH passes strict options and shell-quotes only trusted configured command; request exists only on stdin', async () => {
  const request = { action: 'apply', title: '$(touch NEVER); `calc`', text: 'Кириллица' }, command = sshCommand(config);
  assert.ok(command.args.includes('StrictHostKeyChecking=yes')); assert.ok(command.args.includes('BatchMode=yes'));
  assert.ok(command.args.includes('IdentitiesOnly=yes')); assert.ok(command.args.includes('ClearAllForwardings=yes'));
  assert.ok(command.args.includes(config.identityFile)); assert.ok(!command.args.join(' ').includes(request.title));
  assert.equal(command.args.at(-1), "exec 'php7.4' -d display_errors=stderr -f '/home/account/a'\\''b site/rest/arm_sync.php' -- --arm-ssh");
  let invoked = false;
  const transport = createSshTransport(config, { spawnFn: (executable, args, options) => {
    invoked = true; assert.deepEqual(args, command.args); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    return mock(read + "process.stderr.write('Hosting banner\\n');process.stdout.write(JSON.stringify({ok:true,request:JSON.parse(input)}));});")(executable, args, options);
  } });
  assert.deepEqual(await transport(request), { ok: true, request }); assert.equal(invoked, true);
});

test('SSH distinguishes denied credentials and host key failure without leaking stderr', async () => {
  for (const diagnostic of ['Permission denied (publickey). private secret path', 'Host key verification failed. secret-host']) {
    const transport = createSshTransport(config, { spawnFn: mock(`process.stdin.resume();process.stderr.write(${JSON.stringify(diagnostic)});process.exit(255);`) });
    await assert.rejects(transport({ action: 'ping' }), error => error.transportKind === 'authorization' && !error.message.includes('secret'));
  }
});

test('SSH treats nonzero exit even with JSON as uncertain, and rejects incomplete JSON', async () => {
  for (const script of [read + "process.stdout.write(JSON.stringify({ok:true}));process.exit(255);});", read + "process.stdout.write('{\"ok\":');});"]) {
    const transport = createSshTransport(config, { spawnFn: mock(script) });
    await assert.rejects(transport({ action: 'apply', operation_id: 'same-operation' }), error => error.transportKind === 'connection');
  }
});

test('SSH cancellation terminates the subprocess; bounded stdout and spawn failure cannot confirm delivery', async () => {
  const controller = new AbortController();
  const waiting = createSshTransport(config, { spawnFn: mock('process.stdin.resume();setInterval(()=>{},1000);') });
  const promise = waiting({ action: 'apply' }, { signal: controller.signal }); setTimeout(() => controller.abort(), 25);
  await assert.rejects(promise, /прервано/);
  const large = createSshTransport(config, { spawnFn: mock(read + "process.stdout.write('x'.repeat(9*1024*1024));});") });
  await assert.rejects(large({ action: 'ping' }), /превышает/);
  const missing = createSshTransport(config, { spawnFn: (_, args, options) => spawn(path.join(__dirname, 'nonexistent-ssh-command'), args, options) });
  await assert.rejects(missing({ action: 'ping' }), error => error.transportKind === 'configuration');
});

test('SSH loss after remote apply persists inFlight and readback confirms the same operation after restart', async t => {
  const { BegetSync } = require('../src/stages/beget/sync.cjs'), { PageBuilderStore } = require('../src/stages/page-builder/store.cjs');
  const { testTempRoot } = require('./support.cjs'), crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'ssh-readback-')), remote = path.join(root, 'mock-remote.json');
  const job = { id: crypto.randomUUID(), url: 'https://mori-cinema.reestr35.ru/', attempts: [{ number: 1, htmlMedia: { status: 'complete' } }] };
  const queue = { root, jobs: [job], get: () => job, stage: {} }; queue.pageBuilder = new PageBuilderStore(root, () => job);
  const script = read + `const fs=require('node:fs'),file=process.argv[1],r=JSON.parse(input),state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};let result={ok:true};
    if(r.action==='lookup_company') result.company={id:987,old_id:r.old_id};
    if(r.action==='state') Object.assign(result,{revision:0,fingerprint:'0'.repeat(64)});
    if(r.action==='apply_object'){result={ok:true,operation_id:r.operation_id,epoch:r.epoch,revision:1,fingerprint:'1'.repeat(64),bindings:{tabs:{},blocks:{'block-one':100}},object:{kind:'block',action:'create',local_id:'block-one',id:100},block_tabs:{'block-one':0}};state.applied=result;state.applyCount=(state.applyCount||0)+1;fs.writeFileSync(file,JSON.stringify(state));process.stderr.write('Connection reset by peer');process.exit(255);}
    if(r.action==='operation_status') Object.assign(result,{state:'applied',result:state.applied});
    process.stdout.write(JSON.stringify(result));});`;
  const transport = createSshTransport(config, { spawnFn: (_, args, options) => spawn(process.execPath, ['-e', script, remote], options) });
  let sync = new BegetSync(queue, { destination: config, transport, autoStart: false }); queue.pageBuilder.sync = sync;
  t.after(async () => { await sync.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const current = queue.pageBuilder.read(job.id), document = structuredClone(current.document);
  document.common.blocks.push({ id: 'block-one', type: 'content', view: 'default', title: 'Текст', text: '', media: [], review: { status: 'unreviewed', reason: '' } });
  queue.pageBuilder.write(job.id, current.revision, document, 1); await sync.tick();
  assert.ok(sync.record(job.id, 1).inFlight); assert.equal(queue.pageBuilder.read(job.id).sync.blocks['block-one'].status, 'pending');
  await sync.shutdown(); sync = new BegetSync(queue, { destination: config, transport, autoStart: false }); queue.pageBuilder.sync = sync;
  sync.record(job.id, 1).nextAt = 0; await sync.tick();
  assert.equal(sync.record(job.id, 1).inFlight, null); assert.equal(queue.pageBuilder.read(job.id).sync.blocks['block-one'].status, 'synced');
  assert.equal(JSON.parse(fs.readFileSync(remote)).applyCount, 1);
});
