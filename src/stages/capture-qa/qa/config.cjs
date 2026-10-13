'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { APP_ROOT, dataSubdir } = require('../../../data-dir.cjs');
const { atomicJson } = require('../../../infrastructure/files.cjs');

const DEFAULT_PROVIDER = 'custom:reestr35-arm';
const DEFAULT_MODEL = 'GLM-5.3';
const DEFAULT_REASONING = 'low';
const DEFAULT_API_BASE = 'https://api.z.ai/api/anthropic';
const BRIDGE = path.join(APP_ROOT, 'src', 'stages', 'capture-qa', 'qa', 'zcode-bridge.cjs');

function discoverScript(environment) {
  if (environment.ARM_ZCODE_CJS) {
    if (fs.existsSync(environment.ARM_ZCODE_CJS)) return environment.ARM_ZCODE_CJS;
    throw new Error(`ARM_ZCODE_CJS не указывает на существующий zcode.cjs: ${environment.ARM_ZCODE_CJS}`);
  }
  const roots = [environment.ProgramFiles, environment['ProgramFiles(x86)']].filter(Boolean);
  const found = roots.map(root => path.join(root, 'ZCode', 'resources', 'glm', 'zcode.cjs')).find(file => fs.existsSync(file));
  if (found) return found;
  throw new Error('ZCode CLI не найден. Установите ZCode Desktop или задайте ARM_ZCODE_CJS путём к zcode.cjs');
}

// The app-server materializes its provider registry from a personal provider
// config file. The ARM owns that file so no global user configuration changes.
function personalProviderFile(root, launch) {
  const file = path.join(dataSubdir('zcode', root), 'provider-config.json');
  atomicJson(file, {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [{
          providerId: launch.provider,
          providerName: 'Reestr35 ARM QA agent',
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: launch.apiKey, apiKeyManagementUrl: 'https://z.ai/manage-apikey/apikey-list' },
            api: { type: 'anthropic-messages', baseUrl: launch.apiBase },
            personalModelIds: [launch.model],
          },
        }],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  });
  return file;
}

// The CLI requires its built-in provider catalog. Desktop installs keep it in
// the per-user runtime directory; a standalone CLI keeps it next to the bundle.
// Discovery is explicit so the QA child never depends on ambient ZCode_* env.
function discoverBuiltinProviderConfig(environment) {
  if (environment.ARM_ZCODE_BUILTIN_CONFIG) {
    if (fs.existsSync(environment.ARM_ZCODE_BUILTIN_CONFIG)) return environment.ARM_ZCODE_BUILTIN_CONFIG;
    throw new Error(`ARM_ZCODE_BUILTIN_CONFIG не указывает на существующий zcode-builtin.json: ${environment.ARM_ZCODE_BUILTIN_CONFIG}`);
  }
  for (const root of [environment.ProgramFiles, environment['ProgramFiles(x86)']].filter(Boolean)) {
    const file = path.join(root, 'ZCode', 'resources', 'glm', 'provider', 'zcode-builtin.json');
    if (fs.existsSync(file)) return file;
  }
  const home = environment.USERPROFILE || environment.HOME;
  if (home) {
    const runtimeRoot = path.join(home, '.zcode', 'v2', 'runtime', 'provider');
    try {
      let newest = null;
      for (const relative of fs.readdirSync(runtimeRoot, { recursive: true })) {
        if (path.basename(relative) !== 'zcode-builtin.json') continue;
        const file = path.join(runtimeRoot, relative);
        const modified = fs.statSync(file).mtimeMs;
        if (!newest || modified > newest.modified) newest = { file, modified };
      }
      if (newest) return newest.file;
    } catch { /* absent runtime directory */ }
  }
  throw new Error('Каталог встроенных провайдеров ZCode (zcode-builtin.json) не найден. Установите/запустите ZCode Desktop или задайте ARM_ZCODE_BUILTIN_CONFIG');
}

function resolveZcodeLaunch(environment, { node, root }) {
  if (!node) throw new Error('ZCode QA требует Node >= 22.5 (node:sqlite) из runtime АРМа');
  const apiKey = environment.ARM_ZCODE_API_KEY;
  if (!apiKey) throw new Error('Задайте ARM_ZCODE_API_KEY (API-ключ Z.ai) для QA-агента ZCode; без него запуск QA невозможен');
  const launch = {
    node,
    script: discoverScript(environment),
    bridge: BRIDGE,
    provider: environment.ARM_ZCODE_PROVIDER || DEFAULT_PROVIDER,
    model: environment.ARM_ZCODE_MODEL || DEFAULT_MODEL,
    reasoning: environment.ARM_ZCODE_REASONING || DEFAULT_REASONING,
    apiBase: environment.ARM_ZCODE_API_BASE || DEFAULT_API_BASE,
    apiKey,
    builtinProviderConfig: discoverBuiltinProviderConfig(environment),
  };
  if (/^account:/.test(launch.provider)) throw new Error('ARM_ZCODE_PROVIDER не должен быть account:-провайдером: personal provider с API-ключом');
  launch.personalProviderFile = personalProviderFile(root, launch);
  return launch;
}

function buildArgs() {
  // The ZCode app-server takes no listen flag: stdio is implied.
  return ['app-server'];
}

// Desktop ambient session injection survives nothing here: strip every ZCODE_*
// variable and set only the provider files this backend controls.
function qaEnvironment(environment, personalProviderFile, builtinProviderFile) {
  const clean = Object.fromEntries(Object.entries(environment).filter(([name]) => !/^ZCODE_/i.test(name)));
  if (personalProviderFile) clean.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalProviderFile;
  if (builtinProviderFile) clean.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinProviderFile;
  return clean;
}

module.exports = { resolveZcodeLaunch, personalProviderFile, discoverBuiltinProviderConfig, buildArgs, qaEnvironment, BRIDGE, DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_REASONING, DEFAULT_API_BASE };
