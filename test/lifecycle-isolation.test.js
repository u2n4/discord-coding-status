'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTestEnvironment, runCli } = require('./helpers');

function underTmp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const tmp = path.resolve(os.tmpdir());
  const target = path.resolve(value);
  if (process.platform === 'win32') {
    const lowerTmp = tmp.toLowerCase();
    const lowerTarget = target.toLowerCase();
    return lowerTarget === lowerTmp || lowerTarget.startsWith(lowerTmp + path.sep);
  }
  return target === tmp || target.startsWith(tmp + path.sep);
}

test('test environments force home/config isolation even with hostile overrides', (t) => {
  const realHome = os.homedir();
  const { directory, env } = createTestEnvironment(t, {
    HOME: realHome,
    USERPROFILE: 'C:\\Users\\real-user',
    LOCALAPPDATA: process.env.LOCALAPPDATA || 'C:\\Users\\real-user\\AppData\\Local',
    APPDATA: 'C:\\Users\\real-user\\AppData\\Roaming',
    XDG_CONFIG_HOME: '/home/real-user/.config',
    XDG_DATA_HOME: '/home/real-user/.local/share',
    CODEX_HOME: path.join(realHome, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(realHome, '.claude'),
    DISCORD_CODING_STATUS_CONFIG_DIR: path.join(realHome, 'discord-coding-status'),
    DISCORD_CODING_STATUS_GROK_HOOKS_DIR: path.join(realHome, '.grok', 'hooks'),
    DISCORD_CODING_STATUS_TASK_NAME: 'DiscordCodingStatus',
    DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART: '0',
    DISCORD_CODING_STATUS_STATE_FILE: path.join(realHome, 'discord-coding-status', 'states.json'),
    DISCORD_CODING_STATUS_RPC_LOG_FILE: path.join(realHome, 'rpc.jsonl'),
    NODE_OPTIONS: ''
  });

  assert.equal(env.HOME, directory);
  assert.equal(env.USERPROFILE, directory);
  assert.equal(env.LOCALAPPDATA, directory);
  assert.equal(env.APPDATA, directory);
  assert.equal(env.XDG_CONFIG_HOME, path.join(directory, '.config'));
  assert.equal(env.XDG_DATA_HOME, path.join(directory, '.local', 'share'));
  assert.equal(env.CODEX_HOME, path.join(directory, '.codex'));
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(directory, '.claude'));
  assert.equal(env.DISCORD_CODING_STATUS_CONFIG_DIR, path.join(directory, 'dcs-config'));
  assert.equal(env.DISCORD_CODING_STATUS_GROK_HOOKS_DIR, path.join(directory, 'grok-hooks'));
  assert.equal(env.DISCORD_CODING_STATUS_STATE_FILE, path.join(directory, 'states.json'));
  assert.equal(env.DISCORD_CODING_STATUS_RPC_LOG_FILE, path.join(directory, 'rpc.jsonl'));
  assert.equal(env.DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART, '1');
  assert.match(env.DISCORD_CODING_STATUS_TASK_NAME, /^DCS-Test-/);
  assert.notEqual(env.DISCORD_CODING_STATUS_TASK_NAME, 'DiscordCodingStatus');
  assert.match(env.NODE_OPTIONS, /mock-discord-rpc/);
});

test('test environments honor a second tmpdir for HOME-style overrides', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-isolation-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex');
  const { env } = createTestEnvironment(t, {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: codexHome
  });

  assert.equal(env.HOME, root);
  assert.equal(env.USERPROFILE, root);
  assert.equal(env.CODEX_HOME, codexHome);
  assert.equal(env.DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART, '1');
  assert.match(env.DISCORD_CODING_STATUS_TASK_NAME, /^DCS-Test-/);
});

test('config directory, task name, and skip seams honor overrides with production defaults', (t) => {
  const {
    getConfigDirectory,
    getWindowsTaskName,
    isDaemonRestartSkipped,
    WINDOWS_TASK_NAME
  } = require('../dist/env');
  const prev = {
    config: process.env.DISCORD_CODING_STATUS_CONFIG_DIR,
    task: process.env.DISCORD_CODING_STATUS_TASK_NAME,
    skip: process.env.DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART
  };
  t.after(() => {
    if (prev.config === undefined) {
      delete process.env.DISCORD_CODING_STATUS_CONFIG_DIR;
    } else {
      process.env.DISCORD_CODING_STATUS_CONFIG_DIR = prev.config;
    }
    if (prev.task === undefined) {
      delete process.env.DISCORD_CODING_STATUS_TASK_NAME;
    } else {
      process.env.DISCORD_CODING_STATUS_TASK_NAME = prev.task;
    }
    if (prev.skip === undefined) {
      delete process.env.DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART;
    } else {
      process.env.DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART = prev.skip;
    }
  });

  delete process.env.DISCORD_CODING_STATUS_CONFIG_DIR;
  delete process.env.DISCORD_CODING_STATUS_TASK_NAME;
  delete process.env.DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART;
  assert.equal(getWindowsTaskName(), WINDOWS_TASK_NAME);
  assert.equal(getWindowsTaskName(), 'DiscordCodingStatus');
  assert.equal(isDaemonRestartSkipped(), false);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-isolation-cfg-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const tmpConfig = path.join(scratch, 'dcs');
  process.env.DISCORD_CODING_STATUS_CONFIG_DIR = tmpConfig;
  assert.equal(getConfigDirectory(), path.resolve(tmpConfig));

  process.env.DISCORD_CODING_STATUS_TASK_NAME = 'DCS-Test-dummy';
  assert.equal(getWindowsTaskName(), 'DCS-Test-dummy');

  process.env.DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART = '1';
  assert.equal(isDaemonRestartSkipped(), true);
  process.env.DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART = '0';
  assert.equal(isDaemonRestartSkipped(), false);
});

test('managed daemon restart honors the skip option without shelling out', () => {
  const { restartManagedDaemon } = require('../dist/adapters/startup/service');
  const result = restartManagedDaemon({
    macosLaunchAgentId: 'io.github.discord-coding-status.daemon',
    windowsTaskName: 'DCS-Test-nonexistent-task',
    skipRestart: true
  });
  assert.deepEqual(result, { status: 'skipped' });
});

test('hooks setup under test isolation copies to tmpdir and never restarts the daemon', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-isolation-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex');
  const { env } = createTestEnvironment(t, {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: codexHome
  });

  assert.equal(env.DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART, '1');
  assert.match(env.DISCORD_CODING_STATUS_TASK_NAME, /^DCS-Test-/);
  const configDir = env.DISCORD_CODING_STATUS_CONFIG_DIR;
  assert.ok(underTmp(configDir), `config dir override must be tmpdir-isolated, got ${configDir}`);

  const result = await runCli(['hooks', 'setup', 'codex'], env, 30000);

  const hooksFile = path.join(codexHome, 'hooks.json');
  assert.ok(fs.existsSync(hooksFile), 'expected isolated hooks.json to be written');
  const isolatedRuntime = path.join(configDir, 'app', 'dist', 'cli.js');
  assert.ok(fs.existsSync(isolatedRuntime), `expected isolated runtime at ${isolatedRuntime}`);
  assert.match(result.stdout, /Installed .* Codex hook/);
  assert.doesNotMatch(result.stdout, /Daemon restarted/);
  assert.doesNotMatch(result.stdout, /No managed daemon is installed/);
  assert.doesNotMatch(result.stdout, /could not be restarted/);
});
