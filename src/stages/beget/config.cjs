'use strict';
const fs = require('node:fs'), path = require('node:path');
function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['host', 'user', 'port', 'identityFile', 'remoteScript', 'phpBinary'].includes(key))) throw new Error('Настройка SSH Beget допускает только host, user, port, identityFile, remoteScript и phpBinary');
  if (Object.keys(config).length === 0) return null;
  const { host, user, identityFile, remoteScript, phpBinary = 'php7.4' } = config, port = config.port ?? 22;
  if (typeof host !== 'string' || host.length > 253 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) throw new Error('Некорректный SSH host Beget');
  if (typeof user !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(user)) throw new Error('Некорректный SSH user Beget');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port Beget должен быть числом от 1 до 65535');
  if (typeof identityFile !== 'string' || !path.isAbsolute(identityFile) || /[\x00-\x1f\x7f]/.test(identityFile)) throw new Error('identityFile должен быть абсолютным путём к существующему SSH-ключу');
  try { if (!fs.statSync(identityFile).isFile()) throw new Error(); } catch { throw new Error('SSH-ключ identityFile не найден'); }
  if (typeof remoteScript !== 'string' || remoteScript.length > 2048 || !remoteScript.startsWith('/') || !remoteScript.endsWith('/rest/arm_sync.php')
    || /[\x00-\x1f\x7f\\]/.test(remoteScript) || remoteScript.split('/').some(part => part === '..' || part === '.')) throw new Error('remoteScript должен быть абсолютным серверным путём к /rest/arm_sync.php');
  if (typeof phpBinary !== 'string' || !/^(?:php(?:\d+(?:\.\d+)?)?|\/[a-zA-Z0-9_./-]+)$/.test(phpBinary) || phpBinary.split('/').some(part => part === '..')) throw new Error('Некорректный phpBinary Beget');
  return { host, user, port, identityFile, remoteScript, phpBinary };
}
function loadConfig(root, environment = process.env) {
  const file = path.join(root, 'beget-sync-config.json'); let config = {};
  if (fs.existsSync(file)) {
    if (fs.statSync(file).size > 16384) throw new Error('Файл настройки Beget слишком большой');
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Некорректный JSON настройки Beget'); }
  }
  const overrides = { host: environment.ARM_BEGET_SSH_HOST, user: environment.ARM_BEGET_SSH_USER,
    identityFile: environment.ARM_BEGET_SSH_IDENTITY_FILE, remoteScript: environment.ARM_BEGET_REMOTE_SCRIPT, phpBinary: environment.ARM_BEGET_PHP_BINARY };
  if (environment.ARM_BEGET_SSH_PORT !== undefined) overrides.port = Number(environment.ARM_BEGET_SSH_PORT);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Некорректная настройка SSH Beget');
  return validateConfig({ ...config, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) });
}
module.exports = { loadConfig, validateConfig };
