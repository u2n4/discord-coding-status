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
  assert.equal(enriched.details, 'Model: Claude Opus 5.5');
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

test('model labels read like each app: Opus 5.5, Gemini 4 Argon, GPT-6.1 Sol', (t) => {
  const { displayModelLabel, resetModelLabelCacheForTests } = require('../dist/providers/model-label');
  const codexHome = tempDir(t, 'dcs-label-codex-');
  const grokHome = tempDir(t, 'dcs-label-grok-');
  withEnv(t, 'CODEX_HOME', codexHome);
  withEnv(t, 'DISCORD_CODING_STATUS_GROK_HOME', grokHome);
  resetModelLabelCacheForTests();
  t.after(() => resetModelLabelCacheForTests());
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify([
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol' },
    { slug: 'gpt-6.1-terra', display_name: 'GPT-6.1 Terra' }
  ]));
  fs.writeFileSync(path.join(grokHome, 'models_cache.json'), JSON.stringify({
    models: { 'grok-4.7': { info: { id: 'grok-4.7', name: 'Grok 4.7' } } }
  }));
  const app = { family: 'codex', providerId: 'codexApp' };
  const cli = { family: 'codex', providerId: 'codexCli' };
  assert.equal(displayModelLabel(app, 'gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(displayModelLabel(cli, 'gpt-6.1-sol'), 'GPT-6.1-Sol');
  assert.equal(displayModelLabel(app, 'gpt-6.1-terra'), 'GPT-6.1 Terra');
  assert.equal(displayModelLabel(app, 'gpt-7-nova'), 'GPT-7 Nova', 'a gpt slug missing from the Codex list follows its naming style');
  assert.equal(displayModelLabel(app, 'o9-mini'), 'o9-mini', 'a non-gpt slug missing from the list is shown as-is');
  assert.equal(displayModelLabel({ family: 'grok' }, 'grok-4.7'), 'Grok 4.7');
  assert.equal(displayModelLabel({ family: 'grok' }, 'grok-unknown'), 'grok-unknown');
  const cases = [
    ['claude', 'claude-opus-5-5', 'Opus 5.5'],
    ['claude', 'claude-opus-5-5[1m]', 'Opus 5.5'],
    ['claude', 'claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['claude', 'claude-fable-5-1', 'Fable 5.1'],
    ['claude', 'Opus 5.5', 'Opus 5.5'],
    ['antigravity', 'gemini-4-argon-trial', 'Gemini 4 Argon'],
    ['antigravity', 'gemini-3.8-flash-n', 'Gemini 3.8 Flash'],
    ['antigravity', 'gemini-3-flash-a', 'Gemini 3 Flash'],
    ['antigravity', 'claude-opus-5-5-high', 'Claude Opus 5.5'],
    ['antigravity', 'claude-sonnet-5-5-medium', 'Claude Sonnet 5.5'],
    ['antigravity', 'claude-opus-4-6-thinking', 'Claude Opus 4.6'],
    ['antigravity', 'gpt-oss-120b-medium', 'GPT-OSS 120B'],
    ['antigravity', 'Gemini 4 Argon (Medium)', 'Gemini 4 Argon'],
    ['antigravity', 'GPT-OSS 120B (Medium)', 'GPT-OSS 120B'],
    ['muse', 'muse-spark-1.3-contributor', 'Muse Spark 1.3'],
    ['muse', 'meta.muse-spark-1.3', 'Muse Spark 1.3']
  ];
  for (const [family, id, expected] of cases) {
    assert.equal(displayModelLabel(family, id), expected, `${family} ${id}`);
  }
});

test('Antigravity publishes the app label for a learned placeholder', async (t) => {
  const home = tempDir(t, 'dcs-fix-ag4-');
  withEnv(t, 'DISCORD_CODING_STATUS_ANTIGRAVITY_HOME', home);
  resetAntigravityModelLearning();
  t.after(() => resetAntigravityModelLearning());
  fs.writeFileSync(path.join(home, 'antigravity_state.pbtxt'), 'last_selected_agent_model:  MODEL_PLACEHOLDER_M418\n');
  const enriched = await enrichToolForPresence({
    key: 'state:ag', providerId: 'antigravityApp', family: 'antigravity', source: 'hook', model: null, details: '', state: ''
  });
  assert.equal(enriched.details, 'Model: Gemini 4 Argon');
});

test('the app wins over its CLI unless the CLI is in front', () => {
  const now = Date.now();
  const cliHook = { key: 'state:cc', family: 'claude', providerId: 'claudeCode', source: 'hook', updatedAt: now };
  const desktop = { key: 'process:desktop', family: 'claude', providerId: 'claudeApp', source: 'process', updatedAt: now - 1000 };
  assert.equal(selectNewestTool([cliHook, desktop])?.key, 'process:desktop');
  assert.equal(selectNewestTool([cliHook, desktop], 'claude')?.key, 'process:desktop');
  assert.equal(selectNewestTool([cliHook, desktop], 'claude', 'app')?.key, 'process:desktop');
  assert.equal(selectNewestTool([cliHook, desktop], 'claude', 'cli')?.key, 'state:cc');
  const codexCli = { key: 'state:cx', family: 'codex', providerId: 'codexCli', source: 'hook', updatedAt: now };
  const codexApp = { key: 'process:cxapp', family: 'codex', providerId: 'codexApp', source: 'process', updatedAt: now };
  assert.equal(selectNewestTool([codexCli, codexApp], 'codex')?.key, 'process:cxapp');
  assert.equal(selectNewestTool([codexCli, codexApp], 'codex', 'cli')?.key, 'state:cx');
});

test('Antigravity CLI (agy) shows the model agy applied, like `agy models` lists it', async (t) => {
  const { isAntigravityCliProcess, isAntigravityProcess } = require('../dist/core/detection/tool-detection');
  const agyExe = 'C:/Users/u/AppData/Local/agy/bin/agy.exe';
  assert.equal(isAntigravityCliProcess({ executablePath: agyExe }), true);
  assert.equal(isAntigravityProcess({ executablePath: agyExe }), false);

  const cliHome = tempDir(t, 'dcs-fix-agy-');
  withEnv(t, 'DISCORD_CODING_STATUS_ANTIGRAVITY_CLI_HOME', cliHome);
  fs.writeFileSync(path.join(cliHome, 'settings.json'), JSON.stringify({ model: 'Gemini 3.5 Flash (High)' }));
  const tool = {
    key: 'process:agy', providerId: 'antigravityCli', family: 'antigravity', source: 'process', model: null, details: '', state: ''
  };
  assert.equal((await enrichToolForPresence(tool)).details, 'Model: Gemini 3.5 Flash', 'settings.json is the fallback');

  fs.writeFileSync(path.join(cliHome, 'cli.log'), [
    'I1103 01:48:26.185943 1 model_resolver.go:155] model alias "Gemini 3.5 Flash (High)" resolved to "Gemini 4 Argon (Medium)"',
    'I1103 01:48:26.188029 1 model_config_manager.go:340] Propagating selected model override to backend: label="Gemini 4 Argon (Medium)"',
    'I1103 01:49:02.000000 1 model_config_manager.go:340] Propagating selected model override to backend: label="Claude Sonnet 5.5 (High)"',
    ''
  ].join('\n'));
  assert.equal((await enrichToolForPresence(tool)).details, 'Model: Claude Sonnet 5.5', 'the last applied label wins');
});

test('the Antigravity app outranks agy unless a terminal is in front', () => {
  const now = Date.now();
  const app = { key: 'process:ag', family: 'antigravity', providerId: 'antigravityApp', source: 'process', updatedAt: now };
  const cli = { key: 'process:agy', family: 'antigravity', providerId: 'antigravityCli', source: 'process', updatedAt: now };
  assert.equal(selectNewestTool([cli, app], 'antigravity')?.key, 'process:ag');
  assert.equal(selectNewestTool([cli, app], 'antigravity', 'cli')?.key, 'process:agy');
});
