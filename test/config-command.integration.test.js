'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  createTestEnvironment,
  runCli
} = require('./helpers');

test('config outside a terminal points to the script-friendly flags', async (t) => {
  const { directory, env: baseEnv } = createTestEnvironment(t);
  const env = {
    ...baseEnv,
    HOME: directory,
    USERPROFILE: directory
  };

  await assert.rejects(runCli(['config'], env), /config --show` or `config --reset`/);
});

test('the config editor offers only settings that change something', () => {
  const { CONFIG_EDITOR_FIELDS } = require('../dist/env');
  const { DEFAULT_ANTIGRAVITY_CLIENT_ID, DEFAULT_CODEX_CLIENT_ID } = require('../dist/providers/registry');
  const byKey = new Map(CONFIG_EDITOR_FIELDS.map((field) => [field.key, field]));

  for (const tool of ['CODEX', 'CLAUDE', 'ANTIGRAVITY', 'CURSOR', 'GROK', 'MUSE', 'OPENCODE', 'PI']) {
    const field = byKey.get(`DISCORD_CODING_STATUS_${tool}_CLIENT_ID`);
    assert.ok(field, `${tool} application ID is editable`);
    assert.match(field.defaultValue, /^\d{17,20}$/, `${tool} shows its built-in ID`);
  }
  assert.equal(byKey.get('DISCORD_CODING_STATUS_CODEX_CLIENT_ID').defaultValue, DEFAULT_CODEX_CLIENT_ID);
  assert.equal(byKey.get('DISCORD_CODING_STATUS_ANTIGRAVITY_CLIENT_ID').defaultValue, DEFAULT_ANTIGRAVITY_CLIENT_ID);
  assert.ok(byKey.has('DISCORD_CODING_STATUS_STATE_FILE'));

  for (const inert of [
    'DISCORD_CODING_STATUS_DETAIL_LEVEL',
    'DISCORD_CODING_STATUS_ACTIVITY_STYLE',
    'DISCORD_CODING_STATUS_PLAN_TEXT',
    'DISCORD_CODING_STATUS_LIMITS_TEXT',
    'DISCORD_CODING_STATUS_PREFER_CODEX_CLI',
    'DISCORD_CODING_STATUS_SHOW_ACTIVITY'
  ]) {
    assert.equal(byKey.has(inert), false, `${inert} is not offered`);
  }
});

test('config reset restarts an installed macOS launch agent unless disabled', {
  skip: process.platform !== 'darwin'
}, async (t) => {
  const { directory, env: baseEnv } = createTestEnvironment(t);
  const launchAgentsDirectory = path.join(directory, 'Library', 'LaunchAgents');
  const plistPath = path.join(
    launchAgentsDirectory,
    'io.github.discord-coding-status.daemon.plist'
  );
  const binDirectory = path.join(directory, 'bin');
  const restartLog = path.join(directory, 'restart.log');
  fs.mkdirSync(launchAgentsDirectory, { recursive: true });
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(plistPath, '<plist/>\n');

  const launchctlPath = path.join(binDirectory, 'launchctl');
  fs.writeFileSync(
    launchctlPath,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DCS_RESTART_LOG"\n'
  );
  fs.chmodSync(launchctlPath, 0o755);

  const env = {
    ...baseEnv,
    HOME: directory,
    PATH: `${binDirectory}${path.delimiter}${baseEnv.PATH || ''}`,
    DCS_RESTART_LOG: restartLog
  };
  const reset = await runCli(['config', '--reset'], env);
  assert.match(reset.stdout, /Daemon restarted\. Config is now active\./);
  assert.match(
    fs.readFileSync(restartLog, 'utf8'),
    new RegExp(`kickstart -k gui/${process.getuid()}/io\\.github\\.discord-coding-status\\.daemon`)
  );

  fs.writeFileSync(restartLog, '');
  const skipped = await runCli(['config', '--reset', '--no-restart'], env);
  assert.match(skipped.stdout, /Daemon restart skipped by --no-restart\./);
  assert.equal(fs.readFileSync(restartLog, 'utf8'), '');
});

test('config keeps a custom Discord application ID for every tool', async (t) => {
  const { directory, env: baseEnv } = createTestEnvironment(t);
  const env = {
    ...baseEnv,
    HOME: directory,
    USERPROFILE: directory
  };
  const ids = {
    codexClientId: '100000000000000001',
    claudeClientId: '100000000000000002',
    opencodeClientId: '100000000000000003',
    piClientId: '100000000000000004',
    grokClientId: '100000000000000005',
    cursorClientId: '100000000000000006',
    museClientId: '100000000000000007',
    antigravityClientId: '100000000000000008'
  };
  const configDirectory = path.join(directory, 'discord-coding-status');
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(path.join(configDirectory, 'config.json'), `${JSON.stringify(ids, null, 2)}\n`);

  const shown = await runCli(['config', '--show'], env);
  assert.deepEqual(JSON.parse(shown.stdout), ids);
  assert.equal(shown.stderr, '');
});
