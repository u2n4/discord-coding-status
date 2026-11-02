'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  destroyRpcClient,
  enrichToolForPresence,
  selectNewestTool
} = require('../dist/presence');
const {
  readActiveAntigravityModel,
  resetAntigravityModelLearning
} = require('../dist/providers/antigravity/model');

const liveProcess = { pid: process.pid, executablePath: process.execPath };

function withEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeCodexHome(t) {
  const home = tempDir(t, 'dcs-fix-codex-');
  withEnv(t, 'CODEX_HOME', home);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-cli-default"\n');
  fs.writeFileSync(
    path.join(home, '.codex-global-state.json'),
    JSON.stringify({ 'composer-recent-model-configurations-v1': [{ model: 'gpt-desktop-pick' }] })
  );
  return home;
}

test('Codex CLI never shows the Desktop composer pick', async (t) => {
  writeCodexHome(t);
  const enriched = await enrichToolForPresence({
    key: 'state:codex-cli',
    providerId: 'codexCli',
    family: 'codex',
    source: 'hook',
    model: null,
    updatedAt: Date.now() + 60_000,
    details: '',
    state: ''
  });
  assert.equal(enriched.details, 'Model: gpt-cli-default');
});

test('Codex Desktop uses its own composer pick, not the CLI config', async (t) => {
  writeCodexHome(t);
  const enriched = await enrichToolForPresence({
    key: 'process:codex-app',
    providerId: 'codexApp',
    family: 'codex',
    source: 'process',
    model: null,
    processInfo: liveProcess,
    details: '',
    state: ''
  });
  assert.equal(enriched.details, 'Model: gpt-desktop-pick');
});

test('Codex Desktop without a verified live process stays app-only', async (t) => {
  writeCodexHome(t);
  const enriched = await enrichToolForPresence({
    key: 'process:codex-app',
    providerId: 'codexApp',
    family: 'codex',
    source: 'process',
    model: null,
    details: '',
    state: ''
  });
  assert.equal(enriched.details, '');
});

test('Grok process without a bound session never shows the config default', async (t) => {
  const grokHome = tempDir(t, 'dcs-fix-grok-');
  withEnv(t, 'DISCORD_CODING_STATUS_GROK_HOME', grokHome);
  fs.writeFileSync(path.join(grokHome, 'config.toml'), '[models]\ndefault = "grok-guess"\n');
  const enriched = await enrichToolForPresence({
    key: 'process:grok',
    providerId: 'grokCli',
    family: 'grok',
    source: 'process',
    model: null,
    processInfo: liveProcess,
    details: '',
    state: ''
  });
  assert.equal(enriched.details, '');
});

test('Antigravity learns placeholder ids from its own generation records', (t) => {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (_) {
    t.skip('node:sqlite is not available on this Node version');
    return;
  }
  const home = tempDir(t, 'dcs-fix-ag-');
  withEnv(t, 'DISCORD_CODING_STATUS_ANTIGRAVITY_HOME', home);
  resetAntigravityModelLearning();
  t.after(() => resetAntigravityModelLearning());

  fs.mkdirSync(path.join(home, 'conversations'));
  const db = new sqlite.DatabaseSync(path.join(home, 'conversations', 'conv-1.db'));
  db.exec('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0)');
  const insert = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
  const record = (text) => Buffer.from(text, 'latin1');
  const rows = [
    record('\u0012\u0016MODEL_PLACEHOLDER_M404\u001a\u0016claude-sonnet-5-5-medium'),
    record('\u0012\u0016MODEL_PLACEHOLDER_M404\u001a\u0016claude-sonnet-5-5-medium'),
    record('RESOURCE_EXHAUSTED MODEL_PLACEHOLDER_M404')
  ];
  rows.forEach((blob, index) => insert.run(index, blob, blob.length));
  db.close();

  const stateFile = path.join(home, 'antigravity_state.pbtxt');
  fs.writeFileSync(stateFile, 'last_selected_agent_model:  MODEL_PLACEHOLDER_M404\n');
  assert.equal(readActiveAntigravityModel()?.model, 'claude-sonnet-5-5-medium');

  // A placeholder with no record stays unresolved (app-only), never guessed.
  resetAntigravityModelLearning();
  fs.writeFileSync(stateFile, 'last_selected_agent_model:  MODEL_PLACEHOLDER_M999\n');
  assert.equal(readActiveAntigravityModel(), null);
});

test('Antigravity ignores the transcript path and a stale hook model', async (t) => {
  const home = tempDir(t, 'dcs-fix-ag2-');
  withEnv(t, 'DISCORD_CODING_STATUS_ANTIGRAVITY_HOME', home);
  resetAntigravityModelLearning();
  t.after(() => resetAntigravityModelLearning());
  fs.writeFileSync(path.join(home, 'antigravity_state.pbtxt'), 'last_selected_agent_model:  MODEL_PLACEHOLDER_M402\n');

  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, 'changed setting `Model Selection` from A to `secret text`\n');
  assert.equal(readActiveAntigravityModel(transcript)?.model, 'claude-opus-5-5-high');

  const enriched = await enrichToolForPresence({
    key: 'state:ag',
    providerId: 'antigravityApp',
    family: 'antigravity',
    source: 'process',
    model: 'Gemini 3.8 Flash',
    processInfo: liveProcess,
    details: '',
    state: ''
  });
  assert.equal(enriched.details, 'Model: claude-opus-5-5-high');
  assert.equal(enriched.source, 'process', 'live model reads must not promote a process tool to hook');
});

test('Claude wins over a Codex hook when neither is focused, even process-only', () => {
  const codexHook = { key: 'state:codex', family: 'codex', providerId: 'codexCli', source: 'hook', updatedAt: Date.now() };
  const claudeProcess = { key: 'process:claude', family: 'claude', providerId: 'claudeCode', source: 'process', updatedAt: Date.now() - 60_000 };
  assert.equal(selectNewestTool([codexHook, claudeProcess])?.key, 'process:claude');
  assert.equal(selectNewestTool([codexHook, claudeProcess], 'codex')?.key, 'state:codex');
});

test('destroyRpcClient swallows the async destroy rejection', async () => {
  const seen = [];
  const onRejection = (error) => seen.push(error);
  process.on('unhandledRejection', onRejection);
  try {
    destroyRpcClient({ destroy: () => Promise.reject(new TypeError("Cannot read properties of null (reading 'write')")) });
    destroyRpcClient({ destroy: () => { throw new Error('sync failure'); } });
    destroyRpcClient(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(seen, []);
});

test('Antigravity clears an older hook model when the current pick is unknown', async (t) => {
  const home = tempDir(t, 'dcs-fix-ag3-');
  withEnv(t, 'DISCORD_CODING_STATUS_ANTIGRAVITY_HOME', home);
  resetAntigravityModelLearning();
  t.after(() => resetAntigravityModelLearning());
  fs.writeFileSync(path.join(home, 'antigravity_state.pbtxt'), 'last_selected_agent_model:  MODEL_PLACEHOLDER_M999\n');

  const enriched = await enrichToolForPresence({
    key: 'state:ag',
    providerId: 'antigravityApp',
    family: 'antigravity',
    source: 'hook',
    model: 'claude-opus-5-5-high',
    details: '',
    state: ''
  });
  assert.equal(enriched.details, '');
});
