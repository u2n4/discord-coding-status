'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DAEMON_COMMAND_LINE_PATTERN } = require('../dist/adapters/startup/service');
const { mergeActiveTools, selectNewestTool } = require('../dist/presence');
const { detectActiveTools } = require('../dist/core/detection/active-tools');
const { toolProviders } = require('../dist/providers/registry');
const { isAntigravityCliConversation } = require('../dist/antigravity-hooks');

test('setup stop pattern matches only node/bun running dist/cli.js daemon', () => {
  // .NET -match and JS RegExp agree on this pattern (no lookbehind, no flags).
  const pattern = new RegExp(DAEMON_COMMAND_LINE_PATTERN, 'i');
  const daemons = [
    '"C:\\Program Files\\nodejs\\node.exe"  "C:\\Users\\a\\AppData\\Local\\discord-coding-status\\app\\dist\\cli.js" daemon',
    '"C:\\Program Files\\nodejs\\node.exe" dist/cli.js daemon'.replace('dist/', 'C:/Users/a/codAi/projects/discord-coding-status/dist/'),
    'node C:\\Users\\a\\codAi\\projects\\discord-coding-status\\dist\\cli.js daemon'
  ];
  for (const line of daemons) {
    assert.match(line, pattern, line);
  }
  const bystanders = [
    // An agent whose prompt mentions the daemon command line.
    '"C:\\Program Files\\nodejs\\node.exe" C:\\tools\\agent.js "review discord-coding-status\\dist\\cli.js daemon"',
    // A shell that mentions it.
    'C:\\Program Files\\Git\\bin\\bash.exe -c "cat discord-coding-status/dist/cli.js daemon"',
    // The same CLI running a different command.
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a\\AppData\\Local\\discord-coding-status\\app\\dist\\cli.js" setup',
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a\\AppData\\Local\\discord-coding-status\\app\\dist\\cli.js" hook --event daemon'
  ];
  for (const line of bystanders) {
    assert.doesNotMatch(line, pattern, line);
  }
  assert.equal(DAEMON_COMMAND_LINE_PATTERN.includes("'"), false, 'safe inside a single-quoted PowerShell string');
});

test('a CLI hook does not hide the same tool\'s desktop app', () => {
  const now = Date.now();
  const hook = { key: 'state:cx', family: 'codex', providerId: 'codexCli', source: 'hook', updatedAt: now };
  const app = { key: 'process:codexApp', family: 'codex', providerId: 'codexApp', source: 'process', updatedAt: now };
  const cliProcess = { key: 'process:codexCli', family: 'codex', providerId: 'codexCli', source: 'process', updatedAt: now };
  const merged = mergeActiveTools([hook], [app, cliProcess]);
  assert.deepEqual(merged.map((tool) => tool.key).sort(), ['process:codexApp', 'state:cx']);
  assert.equal(selectNewestTool(merged, 'codex', 'app')?.key, 'process:codexApp');
  assert.equal(selectNewestTool(merged, 'codex', 'cli')?.key, 'state:cx');
});

test('process detection reports the Antigravity app and agy side by side', () => {
  const now = Date.now();
  const processes = [
    {
      pid: 101,
      line: 'C:/Users/a/AppData/Local/Programs/Antigravity/Antigravity.exe',
      executablePath: 'C:/Users/a/AppData/Local/Programs/Antigravity/Antigravity.exe',
      commandLine: '"C:/Users/a/AppData/Local/Programs/Antigravity/Antigravity.exe"',
      cpuMs: 10,
      createdAtMs: now - 1000
    },
    {
      pid: 202,
      line: 'C:/Users/a/AppData/Local/agy/bin/agy.exe',
      executablePath: 'C:/Users/a/AppData/Local/agy/bin/agy.exe',
      commandLine: '"C:/Users/a/AppData/Local/agy/bin/agy.exe"',
      cpuMs: 10,
      createdAtMs: now - 1000
    }
  ];
  const tools = detectActiveTools(processes, toolProviders).filter((tool) => tool.family === 'antigravity');
  assert.deepEqual(tools.map((tool) => tool.providerId).sort(), ['antigravityApp', 'antigravityCli']);
});

test('agy hook conversations are recognised as the CLI surface', (t) => {
  const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-agy-home-'));
  const previous = process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_CLI_HOME;
  process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_CLI_HOME = cliHome;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_CLI_HOME;
    } else {
      process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_CLI_HOME = previous;
    }
    fs.rmSync(cliHome, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(cliHome, 'conversations'));
  fs.writeFileSync(path.join(cliHome, 'conversations', 'aaaaaaaa-1111-2222-3333-444444444444.db'), '');

  assert.equal(isAntigravityCliConversation('aaaaaaaa-1111-2222-3333-444444444444', null), true, 'conversation db under antigravity-cli');
  assert.equal(
    isAntigravityCliConversation('x', path.join(cliHome, 'brain', 'c', '.system_generated', 'logs', 'transcript.jsonl')),
    true,
    'transcript under antigravity-cli'
  );
  assert.equal(isAntigravityCliConversation('bbbbbbbb-1111-2222-3333-444444444444', path.join(os.tmpdir(), 'antigravity', 'brain', 'x.jsonl')), false);
  assert.equal(isAntigravityCliConversation('../../etc', null), false, 'ids are validated before touching the disk');
});
