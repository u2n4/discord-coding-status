'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { filterHookEvents, CODEX_HOOK_EVENTS } = require('../dist/env');
const { CLAUDE_LIFECYCLE_HOOK_EVENTS, CLAUDE_MANAGED_HOOK_MARKER } = require('../dist/claude-hooks');
const { GROK_HOOK_EVENTS } = require('../dist/grok-hooks');
const { JSON_CONFIG_ALIASES, BOOLEAN_CONFIG_KEYS } = require('../dist/commands/config/schema');

test('skipToolHooks config alias and filterHookEvents omit PreToolUse/PostToolUse only when enabled', () => {
  assert.equal(JSON_CONFIG_ALIASES.skipToolHooks, 'DISCORD_CODING_STATUS_SKIP_TOOL_HOOKS');
  assert.equal(BOOLEAN_CONFIG_KEYS.has('DISCORD_CODING_STATUS_SKIP_TOOL_HOOKS'), true);

  assert.deepEqual(filterHookEvents(CLAUDE_LIFECYCLE_HOOK_EVENTS, false), [...CLAUDE_LIFECYCLE_HOOK_EVENTS]);
  assert.deepEqual(
    filterHookEvents(CLAUDE_LIFECYCLE_HOOK_EVENTS, true),
    ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd']
  );
  assert.deepEqual(
    filterHookEvents(CODEX_HOOK_EVENTS, true),
    ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop']
  );
  assert.deepEqual(
    filterHookEvents(GROK_HOOK_EVENTS, true),
    ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopCancelled', 'StopFailure', 'SessionEnd']
  );
});

test('installers with DISCORD_CODING_STATUS_SKIP_TOOL_HOOKS=true strip managed PreToolUse/PostToolUse and keep unrelated hooks', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-skip-tool-hooks-'));
  const claudeDir = path.join(tempRoot, 'claude');
  const codexDir = path.join(tempRoot, 'codex');
  const grokDir = path.join(tempRoot, 'grok');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(grokDir, { recursive: true });

  // Seed existing Claude settings containing BOTH an unrelated PreToolUse hook and old managed Pre/PostToolUse hooks
  const claudeSettings = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(
    claudeSettings,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python -I gate.py hook' }] },
          { matcher: '*', hooks: [{ type: 'command', command: `node cli.js claude-hook --event PreToolUse ${CLAUDE_MANAGED_HOOK_MARKER}` }] }
        ],
        PostToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: `node cli.js claude-hook --event PostToolUse ${CLAUDE_MANAGED_HOOK_MARKER}` }] }
        ]
      }
    }, null, 2)
  );

  // Seed existing Codex hooks with an unrelated PreToolUse hook and an old managed PreToolUse hook
  const codexHooksFile = path.join(codexDir, 'hooks.json');
  fs.writeFileSync(
    codexHooksFile,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python -I codex_hook.py' }] },
          { hooks: [{ type: 'command', command: 'node cli.js codex-hook --event PreToolUse', statusMessage: 'Discord Coding Status' }] }
        ]
      }
    }, null, 2)
  );

  try {
    const script = `
      const { claudeHookInstaller, grokHookInstaller } = require('./dist/hook-installers');
      const { codexHookInstaller } = require('./dist/codex-hooks');
      const cIns = claudeHookInstaller.install('C:/app/cli.js');
      const cStat = claudeHookInstaller.status();
      const xIns = codexHookInstaller.install('C:/app/cli.js');
      const xStat = codexHookInstaller.status();
      const gIns = grokHookInstaller.install('C:/app/cli.js');
      const gStat = grokHookInstaller.status();
      console.log(JSON.stringify({ cIns, cStat, xIns, xStat, gIns, gStat }));
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        DISCORD_CODING_STATUS_SKIP_TOOL_HOOKS: 'true',
        CLAUDE_CONFIG_DIR: claudeDir,
        CODEX_HOME: codexDir,
        DISCORD_CODING_STATUS_GROK_HOOKS_DIR: grokDir
      },
      encoding: 'utf8'
    });
    const res = JSON.parse(out.trim());
    assert.equal(res.cIns.installed, 7);
    assert.equal(res.cStat.installed, true);
    assert.equal(res.xIns.installed, 4);
    assert.equal(res.xStat.installed, true);
    assert.equal(res.gIns.installed, 6);
    assert.equal(res.gStat.installed, true);

    const afterClaude = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
    assert.equal(afterClaude.hooks.PreToolUse.length, 1);
    assert.equal(afterClaude.hooks.PreToolUse[0].hooks[0].command, 'python -I gate.py hook');
    assert.equal(afterClaude.hooks.PostToolUse, undefined);

    const afterCodex = JSON.parse(fs.readFileSync(codexHooksFile, 'utf8'));
    assert.equal(afterCodex.hooks.PreToolUse.length, 1);
    assert.equal(afterCodex.hooks.PreToolUse[0].hooks[0].command, 'python -I codex_hook.py');
    assert.equal(afterCodex.hooks.PostToolUse, undefined);

    const afterGrok = JSON.parse(fs.readFileSync(path.join(grokDir, 'discord-coding-status.json'), 'utf8'));
    assert.equal(afterGrok.hooks.PreToolUse, undefined);
    assert.equal(afterGrok.hooks.PostToolUse, undefined);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('config compaction preserves skipToolHooks=true across save/reload and drops default false cleanly', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-skip-config-persist-'));
  const fakeHome = path.join(tempRoot, 'home');
  const dataDir = path.join(fakeHome, 'discord-coding-status');
  const claudeDir = path.join(fakeHome, '.claude');
  const codexDir = path.join(fakeHome, '.codex');
  const grokDir = path.join(fakeHome, '.grok', 'hooks');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(grokDir, { recursive: true });

  const cfgPath = path.join(dataDir, 'config.json');
  const cliPath = path.resolve(__dirname, '..', 'dist', 'cli.js');
  const baseEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
    DISCORD_CODING_STATUS_GROK_HOOKS_DIR: grokDir
  };
  delete baseEnv.DISCORD_CODING_STATUS_SKIP_TOOL_HOOKS;

  const runInstallersInFreshProcess = () => execFileSync(
    process.execPath,
    ['-e', `
      const { claudeHookInstaller, grokHookInstaller } = require('./dist/hook-installers');
      const { codexHookInstaller } = require('./dist/codex-hooks');
      claudeHookInstaller.install('C:/app/cli.js');
      codexHookInstaller.install('C:/app/cli.js');
      grokHookInstaller.install('C:/app/cli.js');
    `],
    { cwd: path.resolve(__dirname, '..'), env: baseEnv, encoding: 'utf8' }
  );

  try {
    // 1. Save with skipToolHooks: true -> config --show (compactConfigEntries) MUST preserve it!
    fs.writeFileSync(cfgPath, JSON.stringify({ skipToolHooks: true }, null, 2));
    const compactedTrue = JSON.parse(
      execFileSync(process.execPath, [cliPath, 'config', '--show'], {
        cwd: path.resolve(__dirname, '..'),
        env: baseEnv,
        encoding: 'utf8'
      }).trim()
    );
    assert.equal(compactedTrue.skipToolHooks, true, 'compactConfigEntries must preserve skipToolHooks: true');

    // Write the compacted config back (same as setup's writeSetupConfig) and run installers in fresh process
    fs.writeFileSync(cfgPath, JSON.stringify(compactedTrue, null, 2));
    runInstallersInFreshProcess();
    const claudeSet = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    assert.equal(claudeSet.hooks.PreToolUse, undefined);
    assert.equal(claudeSet.hooks.PostToolUse, undefined);
    const codexSet = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'));
    assert.equal(codexSet.hooks.PreToolUse, undefined);
    assert.equal(codexSet.hooks.PostToolUse, undefined);
    const grokSet = JSON.parse(fs.readFileSync(path.join(grokDir, 'discord-coding-status.json'), 'utf8'));
    assert.equal(grokSet.hooks.PreToolUse, undefined);
    assert.equal(grokSet.hooks.PostToolUse, undefined);

    // 2. Toggle back to skipToolHooks: false -> default compacts out and full hooks (incl. Pre/PostToolUse) are restored!
    fs.writeFileSync(cfgPath, JSON.stringify({ skipToolHooks: false }, null, 2));
    const compactedFalse = JSON.parse(
      execFileSync(process.execPath, [cliPath, 'config', '--show'], {
        cwd: path.resolve(__dirname, '..'),
        env: baseEnv,
        encoding: 'utf8'
      }).trim()
    );
    assert.equal(compactedFalse.skipToolHooks, undefined, 'default skipToolHooks: false compacts cleanly');
    fs.writeFileSync(cfgPath, JSON.stringify(compactedFalse, null, 2));
    runInstallersInFreshProcess();
    const claudeRestored = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    assert.equal(claudeRestored.hooks.PreToolUse.length, 1);
    assert.equal(claudeRestored.hooks.PostToolUse.length, 1);
    const codexRestored = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'));
    assert.equal(codexRestored.hooks.PreToolUse.length, 1);
    assert.equal(codexRestored.hooks.PostToolUse.length, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
