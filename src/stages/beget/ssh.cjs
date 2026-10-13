'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const failure = (message, kind = 'connection') => Object.assign(new Error(message), { transportKind: kind });
function sshCommand(config) {
  const remote = `exec ${quote(config.phpBinary)} -d display_errors=stderr -f ${quote(config.remoteScript)} -- --arm-ssh`;
  const args = ['-F', 'none', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
    '-p', String(config.port), '-i', config.identityFile, `${config.user}@${config.host}`, remote];
  const bundledWindows = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : '';
  return { command: bundledWindows && fs.existsSync(bundledWindows) ? bundledWindows : 'ssh', args };
}
function createSshTransport(config, { spawnFn = spawn } = {}) {
  const { command, args } = sshCommand(config);
  return (request, { signal } = {}) => new Promise((resolve, reject) => {
    const input = Buffer.from(JSON.stringify(request));
    if (input.length > 64 * 1024 * 1024) { reject(failure('Запрос Beget превышает 64 MiB', 'configuration')); return; }
    if (signal?.aborted) { reject(failure('Отправка Beget прервана')); return; }
    let child, cause = null, stderr = '', outputBytes = 0; const output = [];
    const abort = () => { cause ||= failure('Соединение SSH с Beget прервано; результат операции требует сверки'); child?.kill('SIGKILL'); };
    try { child = spawnFn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(failure('Не удалось запустить OpenSSH', 'configuration')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { cause ||= failure(error.code === 'ENOENT' ? 'Клиент OpenSSH не найден' : 'Не удалось запустить OpenSSH', 'configuration'); });
    child.stdout.on('data', bytes => {
      outputBytes += bytes.length;
      if (outputBytes > 8 * 1024 * 1024) { cause ||= failure('Ответ Beget превышает допустимый размер'); child.kill('SIGKILL'); }
      else output.push(bytes);
    });
    child.stderr.on('data', bytes => { if (stderr.length < 65536) stderr += bytes.toString('utf8').slice(0, 65536 - stderr.length); });
    child.stdin.on('error', () => { /* The exit status below distinguishes denied access from an interrupted request. */ });
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (cause) { reject(cause); return; }
      if (code !== 0) {
        if (/permission denied|authentication failed|no supported authentication|too many authentication/i.test(stderr)) reject(failure('SSH Beget отклонил доступ; проверьте пользователя и ключ', 'authorization'));
        else if (/host key verification failed|remote host identification has changed|no .* host key is known/i.test(stderr)) reject(failure('Ключ SSH-сервера Beget не подтверждён или изменён', 'authorization'));
        else if (/command not found|could not open input file|no such file or directory/i.test(stderr)) reject(failure('Не найден PHP или remoteScript на Beget', 'configuration'));
        else reject(failure('SSH-соединение с Beget завершилось без подтверждённого ответа; требуется сверка'));
        return;
      }
      let result;
      try { result = JSON.parse(Buffer.concat(output).toString('utf8')); } catch { reject(failure('Beget вернул некорректный JSON через SSH')); return; }
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') { reject(failure('Некорректный формат ответа Beget через SSH')); return; }
      resolve(result);
    });
    child.stdin.end(input);
  });
}
module.exports = { createSshTransport, sshCommand };
