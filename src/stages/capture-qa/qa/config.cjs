'use strict';
const path = require('node:path');
const { APP_ROOT } = require('../../../data-dir.cjs');
function buildArgs(workspace) {
  // Images are attached by the trusted CLI, not opened with a model filesystem tool.
  const disabled = ['hooks', 'memories', 'plugins', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'unified_exec',
    'view_image', 'apps', 'browser_use', 'computer_use', 'code_mode', 'code_mode_host', 'image_generation', 'skill_search'];
  return [...disabled.flatMap(feature => ['--disable', feature]), '--enable', 'skip_host_skill_discovery',
    '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="medium"', '-c', 'project_doc_max_bytes=0', '-c', 'agents.enabled=false',
    '-c', `model_instructions_file=${JSON.stringify(path.join(APP_ROOT, 'src', 'qa-instructions.txt'))}`,
    '-c', `model_catalog_json=${JSON.stringify(path.join(APP_ROOT, 'src', 'qa-models.json'))}`,
    '-c', 'tools.update_plan.enabled=false', '-c', 'tools.experimental_request_user_input.enabled=false',
    '-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false', '-c', 'web_search="disabled"',
    '-c', 'mcp_servers={}', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
    '-C', workspace, 'app-server', '--listen', 'stdio://'];
}

function qaEnvironment(environment) {
  // Desktop tool-pipe/session injection survives CLI feature flags. Keep only
  // CODEX_HOME (the existing credential location), not the ambient app session.
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^CODEX_/i.test(name) || /^CODEX_HOME$/i.test(name)));
}

module.exports = { buildArgs, qaEnvironment };
