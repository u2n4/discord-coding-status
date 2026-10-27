'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  isCodexCliProcess,
  isCodexDesktopProcess,
  isMuseProcess
} = require('../dist/core/detection/tool-detection');
const {
  findToolProviderByAlias,
  toolProviders
} = require('../dist/providers/registry');
const { resolveDiscordApplications } = require('../dist/providers/discord');
const {
  readActiveMuseModel,
  readMuseModelFromFile
} = require('../dist/providers/muse/model');
const { detectSetupTools } = require('../dist/adapters/system/installed-tools');

test('Muse Code processes are detected without capturing unrelated text', () => {
  const windowsBinary = {
    line: 'C:\\Users\\aliha\\AppData\\Local\\Programs\\muse\\muse-bin-1.4.13-R6996.1.exe',
    executablePath: 'C:\\Users\\aliha\\AppData\\Local\\Programs\\muse\\muse-bin-1.4.13-R6996.1.exe',
    commandLine: '"C:\\Users\\aliha\\AppData\\Local\\Programs\\muse\\muse-bin-1.4.13-R6996.1.exe"'
  };
  const posixBinary = {
    line: '/usr/local/bin/muse --model muse-spark-1.3',
    executablePath: '/usr/local/bin/muse',
    commandLine: 'muse --model muse-spark-1.3'
  };

  for (const process of [
    windowsBinary,
    posixBinary,
    'C:\\Tools\\muse.exe',
    '/opt/bin/muse exec "fix the test"'
  ]) {
    assert.equal(isMuseProcess(process), true, JSON.stringify(process));
  }

  for (const process of [
    'C:\\Tools\\amuse.exe',
    'C:\\Program Files\\Museum\\tour.exe',
    'open C:\\notes\\muse.md',
    'code --reuse-window C:\\notes\\muse.txt',
    'node worker.js'
  ]) {
    assert.equal(isMuseProcess(process), false, JSON.stringify(process));
  }
});

test('ChatGPT Classic is never misclassified as the Codex desktop app', () => {
  const classicMain = {
    line: '"C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT-Desktop_1.2026.190.0_x64__2p2nqsd0c76g0\\app\\ChatGPT Classic.exe" ',
    executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT-Desktop_1.2026.190.0_x64__2p2nqsd0c76g0\\app\\ChatGPT Classic.exe'
  };
  const classicRenderer = {
    line: '"C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT-Desktop_1.2026.190.0_x64__2p2nqsd0c76g0\\app\\ChatGPT Classic.exe" --type=renderer --user-data-dir=C:\\Cache',
    executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT-Desktop_1.2026.190.0_x64__2p2nqsd0c76g0\\app\\ChatGPT Classic.exe'
  };
  const codexMain = {
    line: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe" ',
    executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe'
  };

  for (const process of [classicMain, classicRenderer]) {
    assert.equal(isCodexDesktopProcess(process), false, 'classic chat is not codex');
    assert.equal(isCodexCliProcess(process), false, 'classic chat is not a CLI either');
  }
  assert.equal(isCodexDesktopProcess(codexMain), true);
  assert.equal(isCodexCliProcess(codexMain), false);
});

test('headless Codex services are excluded from CLI detection without hiding codex exec', () => {
  const appServer = {
    line: 'C:\\Users\\aliha\\AppData\\Local\\OpenAI\\Codex\\bin\\1\\codex.exe app-server --analytics-default-enabled',
    executablePath: 'C:\\Users\\aliha\\AppData\\Local\\OpenAI\\Codex\\bin\\1\\codex.exe'
  };
  const execServer = {
    line: 'C:\\Users\\aliha\\AppData\\Local\\OpenAI\\Codex\\bin\\1\\codex.exe exec-server --remote https://example.test/api',
    executablePath: 'C:\\Users\\aliha\\AppData\\Local\\OpenAI\\Codex\\bin\\1\\codex.exe'
  };

  for (const process of [appServer, execServer]) {
    assert.equal(isCodexCliProcess(process), false, process.line);
  }
  assert.equal(isCodexCliProcess('/opt/homebrew/bin/codex exec "fix the flaky test"'), true);
  assert.equal(isCodexCliProcess('/opt/homebrew/bin/codex'), true);
});

test('the Muse provider registers a Muse Code Discord identity', () => {
  const provider = findToolProviderByAlias('muse', 'cli');
  assert.ok(provider);
  assert.equal(provider.id, 'museCli');
  assert.equal(provider.family, 'muse');
  assert.equal(provider.discord.application, 'muse');
  assert.equal(provider.discord.label, 'Muse Code');

  const applications = resolveDiscordApplications(toolProviders, (name, fallback = '') => fallback);
  const muse = applications.get('muse');
  assert.ok(muse);
  assert.equal(muse.label, 'Muse Code');
  assert.equal(muse.clientId, '', 'no shared Muse application ships a default ID');
  assert.equal(muse.clientIdEnvironment, 'DISCORD_CODING_STATUS_MUSE_CLIENT_ID');

  const configured = resolveDiscordApplications(
    toolProviders,
    (name, fallback = '') => (name === 'DISCORD_CODING_STATUS_MUSE_CLIENT_ID' ? '123456789012345678' : fallback)
  );
  assert.equal(configured.get('muse').clientId, '123456789012345678');
});

function writeMuseSession(sessionsRoot, dayPath, sessionId, records) {
  const directory = path.join(sessionsRoot, ...dayPath, sessionId);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'session.jsonl');
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

function modelRecord(modelId) {
  return {
    payload_type: 'run.model.configured',
    payload: {
      kind: 'run_model',
      record: { model_id: modelId, display_label: modelId, source: 'test' }
    }
  };
}

test('the Muse model parser reads an explicitly bound file (unbound scan disabled)', (t) => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-xdg-'));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdg;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previous;
    }
    fs.rmSync(xdg, { recursive: true, force: true });
  });

  const sessionsRoot = path.join(xdg, 'muse', 'sessions');
  writeMuseSession(sessionsRoot, ['2026', '10', '26'], 'old-session', [
    modelRecord('muse-spark-1.2')
  ]);
  const freshFile = writeMuseSession(sessionsRoot, ['2026', '10', '27'], 'new-session', [
    modelRecord('muse-spark-1.2'),
    { payload_type: 'tool_batch.effect.started', payload: { event: { tool: 'shell' } } },
    modelRecord('muse-spark-1.3-contributor')
  ]);

  const result = readActiveMuseModel(Date.now() - 15 * 60_000);
  assert.equal(result, null, 'unbound global scan is disabled');
  // (removed: unbound result.model assertion; consensus is not evidence)
  // (removed: unbound sessionFile assertion; session files carry no PID)
  assert.equal(readMuseModelFromFile(freshFile), 'muse-spark-1.3-contributor');
});

test('the Muse model parser ignores routing aliases (unbound scan disabled)', (t) => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-xdg-stale-'));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdg;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previous;
    }
    fs.rmSync(xdg, { recursive: true, force: true });
  });

  const sessionsRoot = path.join(xdg, 'muse', 'sessions');
  const staleFile = writeMuseSession(sessionsRoot, ['2026', '10', '20'], 'stale-session', [
    modelRecord('muse-spark-1.0')
  ]);
  const staleTime = new Date(Date.now() - 2 * 60 * 60_000);
  fs.utimesSync(staleFile, staleTime, staleTime);
  const aliasFile = writeMuseSession(sessionsRoot, ['2026', '10', '27'], 'alias-session', [
    modelRecord('same-as-main')
  ]);

  assert.equal(readMuseModelFromFile(aliasFile), null, 'routing alias is not a model');
  assert.equal(readMuseModelFromFile(staleFile), 'muse-spark-1.0', 'bound parser reads its explicit file');
  assert.equal(readActiveMuseModel(Date.now() - 15 * 60_000), null, 'unbound scan disabled');
});

test('Muse setup probes describe the executable and sessions path', () => {
  const detections = detectSetupTools({
    platform: 'win32',
    homeDirectory: 'C:\\Users\\tester',
    executableOverrides: { museCli: ['C:\\fake\\muse.cmd'] },
    pathExists: () => true,
    executeFile: () => { throw new Error('no executables on PATH'); }
  }, toolProviders);

  const cli = detections.find((detection) => detection.key === 'museCli');
  const home = detections.find((detection) => detection.key === 'museHome');
  assert.ok(cli);
  assert.ok(home);
  assert.equal(cli.name, 'Muse');
  assert.equal(cli.detected, true);
  assert.equal(cli.detail, 'C:\\fake\\muse.cmd');
  assert.equal(home.detected, true);
});
