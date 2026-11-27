'use strict';

// Env overrides must be assigned before requiring any dist/* modules that read
// home/config paths at import time.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-high-effort-'));
const envBackup = new Map();
const ENV_OVERRIDES = {
  CODEX_HOME: path.join(root, 'codex-home'),
  CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
  XDG_DATA_HOME: path.join(root, 'xdg-data'),
  DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE: path.join(root, 'muse-settings.json'),
  DISCORD_CODING_STATUS_GROK_HOME: path.join(root, 'grok-home'),
  DISCORD_CODING_STATUS_T3_HOME: path.join(root, 't3-home'),
  DISCORD_CODING_STATUS_T3_STATE_DB: path.join(root, 't3-absent.sqlite'),
  DISCORD_CODING_STATUS_T3_BROWSER_DATA: path.join(root, 't3-browser'),
  DISCORD_CODING_STATUS_CURSOR_STATE_DB: path.join(root, 'cursor-state.vscdb'),
  DISCORD_CODING_STATUS_OPENCODE_STATE: path.join(root, 'opencode', 'model.json'),
  DISCORD_CODING_STATUS_OPENCODE_MODELS_CACHE: path.join(root, 'opencode', 'models.json'),
  DISCORD_CODING_STATUS_ANTIGRAVITY_HOME: path.join(root, 'antigravity-home'),
  DISCORD_CODING_STATUS_ANTIGRAVITY_CLI_HOME: path.join(root, 'antigravity-cli-home'),
  DISCORD_CODING_STATUS_ANTIGRAVITY_LABEL_CACHE: path.join(root, 'antigravity-models.json'),
  DISCORD_CODING_STATUS_CLAUDE_DESKTOP_SESSIONS: path.join(root, 'claude-desktop-sessions')
};

for (const [key, value] of Object.entries(ENV_OVERRIDES)) {
  envBackup.set(key, process.env[key]);
  process.env[key] = value;
}

const { createTestEnvironment, runCli } = require('./helpers');
const { displayEffortLabel } = require('../dist/core/presence/effort');
const {
  extractEffortFromModelLabel,
  formatModelWithEffort,
  resetModelLabelCacheForTests
} = require('../dist/providers/model-label');
const { buildPresence, enrichToolForPresence } = require('../dist/presence');
const { readT3Presence, resetT3ModelCacheForTests } = require('../dist/providers/t3/model');
const { parseCodexGlobalState, parseCodexCommandLine, readCodexConfiguredModel, readCodexDesktopModel } = require('../dist/providers/codex/model');
const { extractClaudeEffortFromHookInput, extractClaudeEffortFromTranscriptJsonl } = require('../dist/claude-hooks');
const { parseClaudeDesktopButtonEffort } = require('../dist/core/detection/claude-desktop-model');
const { applyClaudeDesktopDisplayOverride } = require('../dist/adapters/system/claude-desktop-model-watch');
const { readLastUsedClaudeDesktopSession } = require('../dist/providers/claude/desktop-sessions');
const { parseCursorApplicationUserSelection } = require('../dist/providers/cursor/model');
const { parseOpenCodeRecentModel } = require('../dist/providers/opencode/model');
const { setCachedProcessList, clearProcessCacheForTests } = require('../dist/adapters/system/process-cache');

let hasSqlite = true;
try {
  require('node:sqlite');
} catch (_) {
  hasSqlite = false;
}

test.after(() => {
  for (const [key, value] of envBackup.entries()) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  clearProcessCacheForTests();
  resetModelLabelCacheForTests();
  resetT3ModelCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function bumpMtime(filePath, offsetMs = 5000) {
  const next = new Date(Date.now() + offsetMs);
  fs.utimesSync(filePath, next, next);
}

function liveProcessInfo(overrides = {}) {
  return {
    pid: 12345,
    executablePath: process.execPath,
    commandLine: process.execPath,
    line: process.execPath,
    createdAtMs: Date.now() - 60_000,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. Core effort whitelist & model formatting rules
// ---------------------------------------------------------------------------

test('displayEffortLabel shows only XHigh, Max, and Ultracode and hides all other tiers', () => {
  for (const input of ['ultracode', 'ULTRACODE', 'ultra-code', 'ultra_code', 'Ultra Code']) {
    assert.equal(displayEffortLabel(input), 'Ultracode', `expected Ultracode for ${input}`);
  }
  for (const input of ['ultra', 'ULTRA', 'Ultra']) {
    assert.equal(displayEffortLabel(input), 'Ultra', `expected Ultra for ${input}`);
  }
  for (const input of ['xhigh', 'XHigh', 'x-high', 'x_high', 'extra high', 'Extra-High', 'extra_high', 'Extra']) {
    assert.equal(displayEffortLabel(input), 'XHigh', `expected XHigh for ${input}`);
  }
  for (const input of ['max', 'MAX', 'Max', 'max effort', 'max-effort', 'max_effort']) {
    assert.equal(displayEffortLabel(input), 'Max', `expected Max for ${input}`);
  }
  for (const input of ['Max · Ultracode', 'max+ultracode', 'max, ultracode', 'Ultracode · Max', 'Max Ultracode']) {
    assert.equal(displayEffortLabel(input), 'Max · Ultracode', `expected Max · Ultracode for ${input}`);
  }
  for (const input of ['XHigh · Ultracode', 'xhigh+ultracode', 'Extra · Ultracode', 'Extra High · Ultracode', 'Extra Ultracode']) {
    assert.equal(displayEffortLabel(input), 'XHigh · Ultracode', `expected XHigh · Ultracode for ${input}`);
  }
  for (const input of ['High · Ultracode', 'Medium · Ultracode', 'Low · Ultracode', 'High Ultracode']) {
    assert.equal(displayEffortLabel(input), 'Ultracode', `expected Ultracode for ${input}`);
  }

  for (const hidden of [
    '', ' ', null, undefined, 42, true,
    'none', 'minimal', 'low', 'medium', 'high', 'standard', 'extended',
    'auto', 'default', 'thinking', 'ultrathink', 'fast', 'xlow',
    '1M', 'Preview', 'random max words'
  ]) {
    assert.equal(displayEffortLabel(hidden), null, `expected null for ${String(hidden)}`);
  }
});

test('formatModelWithEffort avoids double parentheses, respects explicit overrides, and never mistags -max models', () => {
  // Never mislabel model slugs that contain "-max" as effort Max.
  assert.equal(extractEffortFromModelLabel('gpt-5.1-codex-max'), null);
  assert.equal(formatModelWithEffort('codex', 'gpt-5.1-codex-max'), 'GPT-5.1-Codex-Max');
  assert.equal(formatModelWithEffort('codex', 'gpt-5.1-codex-max', 'high'), 'GPT-5.1-Codex-Max');
  assert.equal(formatModelWithEffort('codex', 'gpt-5.1-codex-max', 'xhigh'), 'GPT-5.1-Codex-Max (XHigh)');
  assert.equal(formatModelWithEffort('codex', 'gpt-5.1-codex-max', 'max'), 'GPT-5.1-Codex-Max (Max)');

  // Embedded parenthesized effort is preserved only for the 3 visible tiers and never duplicated.
  assert.equal(formatModelWithEffort('antigravity', 'Gemini 4 Neon (XHigh)'), 'Gemini 4 Neon (XHigh)');
  assert.equal(formatModelWithEffort('antigravity', 'Gemini 4 Neon (XHigh)', 'xhigh'), 'Gemini 4 Neon (XHigh)');
  assert.equal(formatModelWithEffort('antigravity', 'Gemini 4 Neon (High)'), 'Gemini 4 Neon');
  assert.equal(formatModelWithEffort('antigravity', 'Gemini 4 Neon (XHigh)', 'high'), 'Gemini 4 Neon');
  assert.equal(formatModelWithEffort('claude', 'claude-opus-5-5', 'ultracode'), 'Opus 5.5 (Ultracode)');
  assert.equal(formatModelWithEffort('claude', 'claude-opus-5-5', 'high'), 'Opus 5.5');
});

// ---------------------------------------------------------------------------
// 2. T3 Code (SQLite options + LevelDB composer draft + agent count)
// ---------------------------------------------------------------------------

test('T3 Code shows XHigh, Max, and Ultracode from SQLite options, hides lower tiers, and preserves agent count', { skip: !hasSqlite }, async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(root, 't3-options.sqlite');
  const browserDir = path.join(root, 't3-browser-options');
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(browserDir, { recursive: true, force: true });
  process.env.DISCORD_CODING_STATUS_T3_STATE_DB = dbPath;
  process.env.DISCORD_CODING_STATUS_T3_BROWSER_DATA = browserDir;

  writeJson(path.join(ENV_OVERRIDES.DISCORD_CODING_STATUS_T3_HOME, 'caches', 'antigravity.json'), {
    instanceId: 'antigravity',
    models: [{ slug: 'gemini-4-neon', name: 'Gemini 4 Neon' }]
  });
  writeJson(path.join(ENV_OVERRIDES.DISCORD_CODING_STATUS_T3_HOME, 'caches', 'codex.json'), {
    instanceId: 'codex',
    models: [{ slug: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }]
  });
  resetModelLabelCacheForTests();

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads (
        thread_id TEXT PRIMARY KEY,
        payload_json TEXT,
        deleted_at TEXT,
        archived_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE orchestration_v2_projection_nodes (
        thread_id TEXT,
        kind TEXT,
        status TEXT
      );
    `);

    const setThread = (selection, updatedAt, extraThreadCount = 0) => {
      db.prepare('DELETE FROM orchestration_v2_projection_threads').run();
      db.prepare(`
        INSERT INTO orchestration_v2_projection_threads (thread_id, payload_json, deleted_at, archived_at, updated_at)
        VALUES (?, ?, NULL, NULL, ?)
      `).run('t1', JSON.stringify({ modelSelection: selection, lastVisitedAt: updatedAt }), updatedAt);
      for (let i = 0; i < extraThreadCount; i += 1) {
        db.prepare(`
          INSERT INTO orchestration_v2_projection_threads (thread_id, payload_json, deleted_at, archived_at, updated_at)
          VALUES (?, ?, NULL, NULL, ?)
        `).run(`worker-${i}`, JSON.stringify({ modelSelection: selection }), '2026-11-26T00:00:00.000Z');
      }
      resetT3ModelCacheForTests();
    };

    const t3Tool = {
      key: 'process:t3',
      providerId: 't3App',
      family: 't3',
      source: 'process',
      model: null,
      details: '',
      state: 'T3 Code'
    };

    // Antigravity thought_level = xhigh
    setThread({ instanceId: 'antigravity', model: 'gemini-4-neon', options: [{ id: 'thought_level', value: 'xhigh' }] }, '2026-11-27T01:00:00.000Z');
    let enriched = await enrichToolForPresence(t3Tool);
    assert.equal(enriched.details, 'Model: Gemini 4 Neon (XHigh)');
    assert.equal(enriched.state, '');

    // Claude ultracode boolean combines with visible effort (xhigh/max) + 5 active agents with models stay in state
    db.prepare('INSERT INTO orchestration_v2_projection_nodes (thread_id, kind, status) VALUES (?, ?, ?)').run('t1', 'root_turn', 'running');
    for (let i = 0; i < 4; i += 1) {
      db.prepare('INSERT INTO orchestration_v2_projection_nodes (thread_id, kind, status) VALUES (?, ?, ?)').run(`worker-${i}`, 'root_turn', 'running');
    }
    setThread({
      instanceId: 'claudeAgent',
      model: 'claude-opus-5-5',
      options: [{ id: 'effort', value: 'xhigh' }, { id: 'ultracode', value: true }]
    }, '2026-11-27T01:01:00.000Z', 4);
    enriched = await enrichToolForPresence(t3Tool);
    assert.equal(enriched.details, 'Model: Opus 5.5 (XHigh · Ultracode)');
    assert.equal(enriched.state, '5 agents · 5x Opus 5.5');

    // Claude ultracode + high hides high and shows only (Ultracode)
    setThread({
      instanceId: 'claudeAgent',
      model: 'claude-opus-5-5',
      options: [{ id: 'effort', value: 'high' }, { id: 'ultracode', value: true }]
    }, '2026-11-27T01:01:30.000Z', 4);
    enriched = await enrichToolForPresence(t3Tool);
    assert.equal(enriched.details, 'Model: Opus 5.5 (Ultracode)');

    // Codex reasoningEffort = max & ultra
    db.prepare('DELETE FROM orchestration_v2_projection_nodes').run();
    setThread({ instanceId: 'codex', model: 'gpt-6.2-sol', options: [{ id: 'reasoningEffort', value: 'max' }] }, '2026-11-27T01:02:00.000Z');
    enriched = await enrichToolForPresence(t3Tool);
    assert.equal(enriched.details, 'Model: GPT-6.2 Sol (Max)');

    setThread({ instanceId: 'codex', model: 'gpt-6.2-sol', options: [{ id: 'reasoningEffort', value: 'ultra' }] }, '2026-11-27T01:02:30.000Z');
    enriched = await enrichToolForPresence(t3Tool);
    assert.equal(enriched.details, 'Model: GPT-6.2 Sol (Ultra)');

    // Lower effort hidden
    setThread({ instanceId: 'codex', model: 'gpt-6.2-sol', options: [{ id: 'reasoningEffort', value: 'high' }] }, '2026-11-27T01:03:00.000Z');
    enriched = await enrichToolForPresence(t3Tool);
    assert.equal(enriched.details, 'Model: GPT-6.2 Sol');

    // LevelDB composer draft effort-only switch on the same model takes effect immediately
    const levelDbDir = path.join(browserDir, 'Local Storage', 'leveldb');
    fs.mkdirSync(levelDbDir, { recursive: true });
    const draftsKey = Buffer.concat([
      Buffer.from('_t3code://app', 'latin1'),
      Buffer.from([0, 1]),
      Buffer.from('t3code:composer-drafts:v1', 'latin1')
    ]);
    const varint = (value) => {
      const bytes = [];
      let n = value;
      while (n >= 0x80) {
        bytes.push((n & 0x7f) | 0x80);
        n = Math.floor(n / 128);
      }
      bytes.push(n);
      return Buffer.from(bytes);
    };
    const maskedCrc32c = (type, data) => {
      let crc = 0xffffffff;
      for (const byte of [type, ...data]) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
          crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
        }
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
    };
    const batches = [];
    const writeDraft = (options, offsetMs) => {
      const payload = JSON.stringify({
        state: {
          draftsByThreadKey: {
            'env:t1': {
              activeProvider: 'claudeAgent',
              modelSelectionByProvider: {
                claudeAgent: { provider: 'claudeAgent', model: 'claude-opus-5-5', options }
              }
            }
          },
          draftThreadsByThreadKey: {},
          stickyModelSelectionByProvider: {},
          stickyActiveProvider: 'claudeAgent'
        },
        version: 9
      });
      const header = Buffer.alloc(12);
      header.writeBigUInt64LE(BigInt(batches.length + 1), 0);
      header.writeUInt32LE(1, 8);
      const stored = Buffer.concat([Buffer.from([1]), Buffer.from(payload, 'latin1')]);
      const batch = Buffer.concat([
        header,
        Buffer.from([1]),
        varint(draftsKey.length),
        draftsKey,
        varint(stored.length),
        stored
      ]);
      batches.push(batch);
      const blocks = [];
      let block = Buffer.alloc(0);
      for (const entry of batches) {
        let rest = entry;
        let first = true;
        while (true) {
          if (32768 - block.length < 7) {
            blocks.push(Buffer.concat([block, Buffer.alloc(32768 - block.length)]));
            block = Buffer.alloc(0);
          }
          const piece = rest.subarray(0, 32768 - block.length - 7);
          rest = rest.subarray(piece.length);
          const type = first ? (rest.length ? 2 : 1) : (rest.length ? 3 : 4);
          const recHeader = Buffer.alloc(7);
          recHeader.writeUInt32LE(maskedCrc32c(type, piece), 0);
          recHeader.writeUInt16LE(piece.length, 4);
          recHeader[6] = type;
          block = Buffer.concat([block, recHeader, piece]);
          first = false;
          if (!rest.length) {
            break;
          }
        }
      }
      const logFile = path.join(levelDbDir, '000010.log');
      fs.writeFileSync(logFile, Buffer.concat([...blocks, block]));
      bumpMtime(logFile, offsetMs);
    };

    writeDraft({ effort: 'high' }, 1000);
    // First observation seeds the baseline; second observation with changed effort activates draft focus.
    readT3Presence();
    writeDraft({ effort: 'max', ultracode: true }, 4000);
    enriched = await enrichToolForPresence(t3Tool);
    assert.equal(enriched.details, 'Model: Opus 5.5 (Max · Ultracode)');

    writeDraft({ effort: 'medium', ultracode: false }, 8000);
    enriched = await enrichToolForPresence(t3Tool);
    assert.equal(enriched.details, 'Model: Opus 5.5');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Codex CLI (config.toml, CLI flags, and rollout hook)
// ---------------------------------------------------------------------------

test('Codex CLI shows XHigh/Max from config.toml and CLI flags and hides lower effort', async () => {
  const codexHome = ENV_OVERRIDES.CODEX_HOME;
  writeJson(path.join(codexHome, 'models_cache.json'), {
    models: [{ slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol' }]
  });
  resetModelLabelCacheForTests();

  const configPath = path.join(codexHome, 'config.toml');
  writeText(configPath, 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "xhigh"\n');
  bumpMtime(configPath, 1000);

  const codexProcessTool = (commandLine, createdAtMs = Date.now() - 60_000) => ({
    key: 'process:codexCli',
    providerId: 'codexCli',
    family: 'codex',
    source: 'process',
    model: null,
    details: '',
    state: 'Codex',
    processInfo: liveProcessInfo({ commandLine, line: commandLine, createdAtMs })
  });

  let enriched = await enrichToolForPresence(codexProcessTool('codex'));
  assert.equal(enriched.details, 'Model: GPT-6.2 Sol (XHigh)');

  // Direct parser check for -c model_reasoning_effort=...
  const parsed = parseCodexCommandLine('codex --model gpt-6.2-sol -c model_reasoning_effort=max');
  assert.deepEqual(parsed, { model: 'gpt-6.2-sol', effort: 'max' });

  // Config changes to lower effort -> hidden for plain process AND overrides an older launched process (/effort switch)
  writeText(configPath, 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "high"\n');
  bumpMtime(configPath, 3000);
  assert.equal(readCodexConfiguredModel()?.effort, 'high');

  enriched = await enrichToolForPresence(codexProcessTool('codex'));
  assert.equal(enriched.details, 'Model: GPT-6.2 Sol');

  // Newly launched process (created AFTER config.toml's mtime) honors its CLI --effort override
  enriched = await enrichToolForPresence(codexProcessTool('codex -m gpt-6.2-sol --effort max', Date.now() + 10_000));
  assert.equal(enriched.details, 'Model: GPT-6.2 Sol (Max)');
});

test('Codex CLI hook reads rollout effort and collaboration_mode effort', async (t) => {
  const { env, stateFile } = createTestEnvironment(t);
  const sessionsDir = path.join(env.CODEX_HOME, 'sessions', '2026', '11', '27');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const threadA = '11111111-1111-4111-8111-111111111111';
  const rolloutA = path.join(sessionsDir, `rollout-2026-11-27T00-00-00-${threadA}.jsonl`);
  writeText(
    rolloutA,
    `${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.2-sol', effort: 'xhigh' } })}\n`
  );

  await runCli(
    ['codex-hook', '--event', 'UserPromptSubmit'],
    env,
    15000,
    JSON.stringify({ session_id: threadA, cwd: process.cwd(), transcript_path: rolloutA })
  );

  let stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(stored.sessions[threadA].model, 'gpt-6.2-sol');
  assert.equal(stored.sessions[threadA].effort, 'xhigh');

  // Collaboration mode fallback when top-level effort is omitted
  const threadB = '22222222-2222-4222-8222-222222222222';
  const rolloutB = path.join(sessionsDir, `rollout-2026-11-27T00-01-00-${threadB}.jsonl`);
  writeText(
    rolloutB,
    `${JSON.stringify({
      type: 'turn_context',
      payload: {
        model: 'gpt-6.2-sol',
        collaboration_mode: { settings: { reasoning_effort: 'max' } }
      }
    })}\n`
  );

  await runCli(
    ['codex-hook', '--event', 'UserPromptSubmit'],
    env,
    15000,
    JSON.stringify({ session_id: threadB, cwd: process.cwd(), transcript_path: rolloutB })
  );

  stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(stored.sessions[threadB].effort, 'max');
});

// ---------------------------------------------------------------------------
// 4. Codex Desktop (.codex-global-state.json owner atoms)
// ---------------------------------------------------------------------------

test('Codex Desktop reads model and effort from the active electron-renderer-content-owner', async () => {
  const globalStateFile = path.join(ENV_OVERRIDES.CODEX_HOME, '.codex-global-state.json');
  writeJson(path.join(ENV_OVERRIDES.CODEX_HOME, 'models_cache.json'), {
    models: [{ slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol' }]
  });
  resetModelLabelCacheForTests();

  const writeGlobalState = (effort, offsetMs) => {
    writeJson(globalStateFile, {
      'electron-renderer-content-owner': 'owner-active',
      'electron-owner-atoms:owner-old': {
        'composer-recent-model-configurations-v1': [{ model: 'gpt-old', reasoningEffort: 'low' }]
      },
      'electron-owner-atoms:owner-active': {
        'composer-recent-model-configurations-v1': [{ model: 'gpt-6.2-sol', reasoningEffort: effort }]
      }
    });
    bumpMtime(globalStateFile, offsetMs);
  };

  writeGlobalState('xhigh', 1000);
  assert.deepEqual(parseCodexGlobalState(fs.readFileSync(globalStateFile, 'utf8')), {
    model: 'gpt-6.2-sol',
    effort: 'xhigh'
  });
  assert.equal(readCodexDesktopModel()?.effort, 'xhigh');

  const tool = {
    key: 'process:codexApp',
    providerId: 'codexApp',
    family: 'codex',
    source: 'process',
    model: null,
    details: '',
    state: 'Codex',
    processInfo: liveProcessInfo()
  };

  let enriched = await enrichToolForPresence(tool);
  assert.equal(enriched.details, 'Model: GPT-6.2 Sol (XHigh)');

  writeGlobalState('max', 4000);
  enriched = await enrichToolForPresence(tool);
  assert.equal(enriched.details, 'Model: GPT-6.2 Sol (Max)');

  writeGlobalState('high', 8000);
  enriched = await enrichToolForPresence(tool);
  assert.equal(enriched.details, 'Model: GPT-6.2 Sol');

  // Modern Codex Desktop: .codex-global-state.sqlite + live config.toml updates (ultra/max/xhigh)
  if (hasSqlite) {
    const { DatabaseSync } = require('node:sqlite');
    const sqliteFile = path.join(ENV_OVERRIDES.CODEX_HOME, '.codex-global-state.sqlite');
    const configPath = path.join(ENV_OVERRIDES.CODEX_HOME, 'config.toml');
    const db = new DatabaseSync(sqliteFile);
    try {
      db.exec('CREATE TABLE settings (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key)) WITHOUT ROWID;');
      db.prepare('INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)').run('global', 'electron-renderer-content-owner', JSON.stringify('owner-new'));
      db.prepare('INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)').run(
        'electron-owner-atoms:owner-new',
        'composer-recent-model-configurations-v1',
        JSON.stringify([{ model: 'gpt-6.2-sol', reasoningEffort: 'xhigh', serviceTier: null }])
      );
    } finally {
      db.close();
    }

    // Without config.toml, falls back to SQLite's active owner configuration
    fs.rmSync(configPath, { force: true });
    enriched = await enrichToolForPresence(tool);
    assert.equal(enriched.details, 'Model: GPT-6.2 Sol (XHigh)');

    // When Codex Desktop writes the live composer pick to config.toml (Ultra / Max / XHigh / High)
    writeText(configPath, 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "ultra"\n');
    bumpMtime(configPath, 10000);
    enriched = await enrichToolForPresence(tool);
    assert.equal(enriched.details, 'Model: GPT-6.2 Sol (Ultra)');

    writeText(configPath, 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "max"\n');
    bumpMtime(configPath, 12000);
    enriched = await enrichToolForPresence(tool);
    assert.equal(enriched.details, 'Model: GPT-6.2 Sol (Max)');

    writeText(configPath, 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "high"\n');
    bumpMtime(configPath, 14000);
    enriched = await enrichToolForPresence(tool);
    assert.equal(enriched.details, 'Model: GPT-6.2 Sol');

    fs.rmSync(sqliteFile, { force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Claude Code CLI (transcript ultracode/effort, hooks, CLI flags, settings.json)
// ---------------------------------------------------------------------------

test('Claude Code transcript tracks ultra_effort_enter/exit and api-request output_config.effort', () => {
  assert.equal(extractClaudeEffortFromHookInput({ ultracode: true, effort: 'xhigh' }), 'XHigh · Ultracode');
  assert.equal(extractClaudeEffortFromHookInput({ ultracode: true, effort: 'max' }), 'Max · Ultracode');
  assert.equal(extractClaudeEffortFromHookInput({ ultracode: true, effort: 'high' }), 'Ultracode');
  assert.equal(extractClaudeEffortFromHookInput({ effortLevel: 'max' }), 'max');

  const enteredUltra = [
    JSON.stringify({ type: 'attachment', attachment: { type: 'ultra_effort_enter' } }),
    JSON.stringify({ type: 'api-request', params: { model: 'claude-opus-5-5', output_config: { effort: 'xhigh' } } })
  ].join('\n');
  assert.equal(extractClaudeEffortFromTranscriptJsonl(enteredUltra), 'XHigh · Ultracode');

  const exitedUltra = [
    enteredUltra,
    JSON.stringify({ type: 'attachment', attachment: { type: 'ultra_effort_exit' } }),
    JSON.stringify({ type: 'api-request', params: { model: 'claude-opus-5-5', output_config: { effort: 'xhigh' } } })
  ].join('\n');
  assert.equal(extractClaudeEffortFromTranscriptJsonl(exitedUltra), 'xhigh');

  const haikuDuringUltra = [
    JSON.stringify({ type: 'attachment', attachment: { type: 'ultra_effort_enter' } }),
    JSON.stringify({ type: 'api-request', params: { model: 'claude-fable-5-2', output_config: { effort: 'max' } } }),
    JSON.stringify({ type: 'api-request', params: { model: 'claude-haiku-5-5', output_config: { effort: 'medium' } } })
  ].join('\n');
  assert.equal(extractClaudeEffortFromTranscriptJsonl(haikuDuringUltra), 'Max · Ultracode');

  const highWithUltra = [
    JSON.stringify({ type: 'attachment', attachment: { type: 'ultra_effort_enter' } }),
    JSON.stringify({ type: 'api-request', params: { model: 'claude-fable-5-2', output_config: { effort: 'high' } } })
  ].join('\n');
  assert.equal(extractClaudeEffortFromTranscriptJsonl(highWithUltra), 'Ultracode');

  const exitedToHigh = [
    haikuDuringUltra,
    JSON.stringify({ type: 'attachment', attachment: { type: 'ultra_effort_exit' } }),
    JSON.stringify({ type: 'api-request', params: { model: 'claude-fable-5-2', output_config: { effort: 'high' } } })
  ].join('\n');
  assert.equal(extractClaudeEffortFromTranscriptJsonl(exitedToHigh), 'high');

  const maxRequest = JSON.stringify({ type: 'api-request', params: { output_config: { effort: 'max' } } });
  assert.equal(extractClaudeEffortFromTranscriptJsonl(maxRequest), 'max');
});

test('Claude Code CLI hook, CLI flags, and settings.json effortLevel format visible tiers only', async (t) => {
  const { env, stateFile } = createTestEnvironment(t);
  const transcriptPath = path.join(env.CLAUDE_CONFIG_DIR, 'projects', 'demo', 'claude-s1.jsonl');
  writeText(transcriptPath, [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } }),
    JSON.stringify({ type: 'attachment', attachment: { type: 'ultra_effort_enter' } }),
    JSON.stringify({ type: 'api-request', params: { output_config: { effort: 'xhigh' } } })
  ].join('\n') + '\n');

  await runCli(
    ['claude-hook', '--event', 'UserPromptSubmit'],
    env,
    15000,
    JSON.stringify({ session_id: 'claude-s1', cwd: process.cwd(), transcript_path: transcriptPath })
  );

  const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(stored.sessions['claude-s1'].model, 'claude-opus-5-5');
  assert.equal(stored.sessions['claude-s1'].effort, 'XHigh · Ultracode');

  // Direct process CLI flags
  const claudeCliTool = (overrides = {}) => ({
    key: 'state:claude-cli',
    providerId: 'claudeCode',
    family: 'claude',
    source: 'hook',
    model: 'claude-opus-5-5',
    details: '',
    state: 'Claude Code',
    ...overrides
  });

  let enriched = await enrichToolForPresence(claudeCliTool({
    processInfo: liveProcessInfo({ commandLine: 'claude --effort max', line: 'claude --effort max' })
  }));
  assert.equal(enriched.details, 'Model: Opus 5.5 (Max)');

  enriched = await enrichToolForPresence(claudeCliTool({
    processInfo: liveProcessInfo({ commandLine: 'claude --ultracode', line: 'claude --ultracode' })
  }));
  assert.equal(enriched.details, 'Model: Opus 5.5 (Ultracode)');

  enriched = await enrichToolForPresence(claudeCliTool({
    processInfo: liveProcessInfo({ commandLine: 'claude --effort max --ultracode', line: 'claude --effort max --ultracode' })
  }));
  assert.equal(enriched.details, 'Model: Opus 5.5 (Max · Ultracode)');

  // settings.json fallback when no hook/flag effort is provided
  const settingsFile = path.join(ENV_OVERRIDES.CLAUDE_CONFIG_DIR, 'settings.json');
  writeJson(settingsFile, { effortLevel: 'xhigh' });
  bumpMtime(settingsFile, 2000);
  enriched = await enrichToolForPresence(claudeCliTool());
  assert.equal(enriched.details, 'Model: Opus 5.5 (XHigh)');

  writeJson(settingsFile, { effortLevel: 'high' });
  bumpMtime(settingsFile, 6000);
  enriched = await enrichToolForPresence(claudeCliTool());
  assert.equal(enriched.details, 'Model: Opus 5.5');
});

// ---------------------------------------------------------------------------
// 6. Claude Desktop (UIA button effort + background local_*.json sessions)
// ---------------------------------------------------------------------------

test('Claude Desktop parses UIA button effort and background local_*.json sessions', async () => {
  assert.equal(parseClaudeDesktopButtonEffort('Model: Opus 5.5 Extra', 'Opus 5.5'), 'XHigh');
  assert.equal(parseClaudeDesktopButtonEffort('Model: Opus 5.5 Max', 'Opus 5.5'), 'Max');
  assert.equal(parseClaudeDesktopButtonEffort('Model: Fable 5.2 Max', 'Fable 5.2'), 'Max');
  assert.equal(parseClaudeDesktopButtonEffort('Model: Opus 5.5 Ultracode', 'Opus 5.5'), 'Ultracode');
  assert.equal(parseClaudeDesktopButtonEffort('Model: Fable 5.2 Max · Ultracode', 'Fable 5.2'), 'Max · Ultracode');
  assert.equal(parseClaudeDesktopButtonEffort('Model: Fable 5.2 High · Ultracode', 'Fable 5.2'), 'Ultracode');
  assert.equal(parseClaudeDesktopButtonEffort('Model: Opus 5.5 Extra · Ultracode', 'Opus 5.5'), 'XHigh · Ultracode');
  assert.equal(parseClaudeDesktopButtonEffort('Model: Fable 5.2 Max Ultracode', 'Fable 5.2'), 'Max · Ultracode');
  assert.equal(parseClaudeDesktopButtonEffort('Model: Opus 5.5 High', 'Opus 5.5'), null);
  assert.equal(parseClaudeDesktopButtonEffort('Model: Opus 5.5', 'Opus 5.5'), null);
  assert.equal(parseClaudeDesktopButtonEffort('Model: Sonnet 5.5 Extra', 'Opus 5.5'), null);

  const baseTools = [{
    key: 'process:claudeApp',
    providerId: 'claudeApp',
    family: 'claude',
    source: 'process',
    details: '',
    state: ''
  }];

  const [withExtra] = applyClaudeDesktopDisplayOverride(baseTools, { kind: 'model', model: 'Opus 5.5', effort: 'XHigh' });
  assert.equal(withExtra.details, 'Model: Opus 5.5 (XHigh)');

  const [withUltra] = applyClaudeDesktopDisplayOverride(baseTools, { kind: 'model', model: 'Opus 5.5', effort: 'ultracode' });
  assert.equal(withUltra.details, 'Model: Opus 5.5 (Ultracode)');

  const [withMaxUltra] = applyClaudeDesktopDisplayOverride(baseTools, { kind: 'model', model: 'Fable 5.2', effort: 'Max+Ultracode' });
  assert.equal(withMaxUltra.details, 'Model: Fable 5.2 (Max · Ultracode)');

  const [withXHighUltra] = applyClaudeDesktopDisplayOverride(baseTools, { kind: 'model', model: 'Opus 5.5', effort: 'XHigh+Ultracode' });
  assert.equal(withXHighUltra.details, 'Model: Opus 5.5 (XHigh · Ultracode)');

  const [withHigh] = applyClaudeDesktopDisplayOverride(baseTools, { kind: 'model', model: 'Opus 5.5', effort: 'high' });
  assert.equal(withHigh.details, 'Model: Opus 5.5');

  // Background Code-tab session file: sessionSettings.ultracode combines with visible effort and hides lower effort
  const sessionsRoot = ENV_OVERRIDES.DISCORD_CODING_STATUS_CLAUDE_DESKTOP_SESSIONS;
  const sessionFile = path.join(sessionsRoot, 'acct', 'org', 'local_1.json');
  const writeSession = (record, offsetMs) => {
    writeJson(sessionFile, record);
    bumpMtime(sessionFile, offsetMs);
  };

  const hostProcess = liveProcessInfo({ pid: 9001, executablePath: 'C:\\Claude\\claude.exe', commandLine: 'C:\\Claude\\claude.exe' });
  const runnerProcess = liveProcessInfo({
    pid: 9002,
    ppid: 9001,
    executablePath: 'C:\\Claude\\claude-code\\claude.exe',
    commandLine: 'claude.exe --output-format stream-json --resume sess-desktop-1 --model claude-opus-5-5'
  });
  setCachedProcessList([hostProcess, runnerProcess]);

  writeSession({
    cliSessionId: 'sess-desktop-1',
    model: 'claude-fable-5-2',
    effort: 'high',
    sessionSettings: { ultracode: true },
    lastFocusedAt: 2000
  }, 1000);

  let picked = readLastUsedClaudeDesktopSession(9001, [hostProcess, runnerProcess]);
  assert.equal(picked?.effort, 'Ultracode');

  let enriched = await enrichToolForPresence({
    key: 'process:claudeApp',
    providerId: 'claudeApp',
    family: 'claude',
    source: 'process',
    model: null,
    details: '',
    state: '',
    processInfo: hostProcess
  });
  assert.equal(enriched.details, 'Model: Fable 5.2 (Ultracode)');

  writeSession({
    cliSessionId: 'sess-desktop-1',
    model: 'claude-fable-5-2',
    effort: 'max',
    sessionSettings: { ultracode: true },
    lastFocusedAt: 2500
  }, 2500);
  picked = readLastUsedClaudeDesktopSession(9001, [hostProcess, runnerProcess]);
  assert.equal(picked?.effort, 'Max · Ultracode');
  enriched = await enrichToolForPresence({
    key: 'process:claudeApp',
    providerId: 'claudeApp',
    family: 'claude',
    source: 'process',
    model: null,
    details: '',
    state: '',
    processInfo: hostProcess
  });
  assert.equal(enriched.details, 'Model: Fable 5.2 (Max · Ultracode)');

  writeSession({
    cliSessionId: 'sess-desktop-1',
    model: 'claude-opus-5-5',
    effort: 'max',
    lastFocusedAt: 3000
  }, 4000);
  enriched = await enrichToolForPresence({
    key: 'process:claudeApp',
    providerId: 'claudeApp',
    family: 'claude',
    source: 'process',
    model: null,
    details: '',
    state: '',
    processInfo: hostProcess
  });
  assert.equal(enriched.details, 'Model: Opus 5.5 (Max)');

  writeSession({
    cliSessionId: 'sess-desktop-1',
    model: 'claude-opus-5-5',
    effort: 'high',
    lastFocusedAt: 4000
  }, 8000);
  enriched = await enrichToolForPresence({
    key: 'process:claudeApp',
    providerId: 'claudeApp',
    family: 'claude',
    source: 'process',
    model: null,
    details: '',
    state: '',
    processInfo: hostProcess
  });
  assert.equal(enriched.details, 'Model: Opus 5.5');
  clearProcessCacheForTests();
});

// ---------------------------------------------------------------------------
// 7. Antigravity Desktop & CLI (agy)
// ---------------------------------------------------------------------------

test('Antigravity Desktop and CLI show XHigh and hide High/Medium', async () => {
  const agyHome = ENV_OVERRIDES.DISCORD_CODING_STATUS_ANTIGRAVITY_HOME;
  const agyLabelCache = ENV_OVERRIDES.DISCORD_CODING_STATUS_ANTIGRAVITY_LABEL_CACHE;
  const agyCliHome = ENV_OVERRIDES.DISCORD_CODING_STATUS_ANTIGRAVITY_CLI_HOME;

  // Desktop: state pbtxt + live labels cache
  writeJson(agyLabelCache, {
    fetchedAt: Date.now(),
    labels: {
      MODEL_PLACEHOLDER_M101: 'Gemini 4 Neon (XHigh)',
      MODEL_PLACEHOLDER_M102: 'Gemini 4 Neon (High)'
    }
  });

  const desktopTool = {
    key: 'process:antigravity',
    providerId: 'antigravity',
    family: 'antigravity',
    source: 'process',
    model: null,
    details: '',
    state: ''
  };

  writeText(path.join(agyHome, 'antigravity_state.pbtxt'), 'last_selected_agent_model: MODEL_PLACEHOLDER_M101\n');
  let enriched = await enrichToolForPresence(desktopTool);
  assert.equal(enriched.details, 'Model: Gemini 4 Neon (XHigh)');

  writeText(path.join(agyHome, 'antigravity_state.pbtxt'), 'last_selected_agent_model: MODEL_PLACEHOLDER_M102\n');
  enriched = await enrichToolForPresence(desktopTool);
  assert.equal(enriched.details, 'Model: Gemini 4 Neon');

  // CLI: cli.log
  const cliLog = path.join(agyCliHome, 'cli.log');
  const cliTool = {
    key: 'process:antigravityCli',
    providerId: 'antigravityCli',
    family: 'antigravity',
    source: 'process',
    model: null,
    details: '',
    state: ''
  };

  writeText(cliLog, 'model_config_manager.go] Propagating selected model override to backend: label="Gemini 4 Hydrogen (XHigh)"\n');
  bumpMtime(cliLog, 1000);
  enriched = await enrichToolForPresence(cliTool);
  assert.equal(enriched.details, 'Model: Gemini 4 Hydrogen (XHigh)');

  writeText(cliLog, 'model_config_manager.go] Propagating selected model override to backend: label="Gemini 4 Hydrogen (High)"\n');
  bumpMtime(cliLog, 5000);
  enriched = await enrichToolForPresence(cliTool);
  assert.equal(enriched.details, 'Model: Gemini 4 Hydrogen');
});

// ---------------------------------------------------------------------------
// 8. Cursor (state.vscdb parameters + ignores maxMode 1M-context toggle)
// ---------------------------------------------------------------------------

test('Cursor reads effort parameter from state.vscdb and ignores maxMode context toggle', { skip: !hasSqlite }, async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = ENV_OVERRIDES.DISCORD_CODING_STATUS_CURSOR_STATE_DB;
  fs.rmSync(dbPath, { force: true });

  const makePayload = (parameters) => ({
    aiSettings: {
      modelConfig: {
        composer: {
          modelName: 'claude-opus-5.5',
          selectedModels: [{ modelId: 'claude-opus-5.5', parameters }]
        }
      }
    },
    availableDefaultModels2: [
      { serverModelName: 'claude-opus-5.5', inputboxShortModelName: 'Claude Opus 5.5' }
    ]
  });

  // Direct parser assertions including maxMode isolation
  assert.deepEqual(
    parseCursorApplicationUserSelection(makePayload([{ id: 'effort', value: 'high' }, { id: 'maxMode', value: true }])),
    { model: 'Claude Opus 5.5', effort: 'high' }
  );
  assert.deepEqual(
    parseCursorApplicationUserSelection(makePayload([{ id: 'effort', value: 'xhigh' }])),
    { model: 'Claude Opus 5.5', effort: 'xhigh' }
  );

  const APP_USER_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
  const writeCursorState = (parameters, offsetMs) => {
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(APP_USER_KEY, JSON.stringify(makePayload(parameters)));
    bumpMtime(dbPath, offsetMs);
  };

  const cursorTool = {
    key: 'process:cursorApp',
    providerId: 'cursorApp',
    family: 'cursor',
    source: 'process',
    model: null,
    details: '',
    state: ''
  };

  writeCursorState([{ id: 'effort', value: 'xhigh' }], 1000);
  let enriched = await enrichToolForPresence(cursorTool);
  assert.equal(enriched.details, 'Model: Claude Opus 5.5 (XHigh)');

  writeCursorState([{ id: 'effort', value: 'max' }], 4000);
  enriched = await enrichToolForPresence(cursorTool);
  assert.equal(enriched.details, 'Model: Claude Opus 5.5 (Max)');

  // maxMode: true with effort: high MUST NOT display (Max)
  writeCursorState([{ id: 'effort', value: 'high' }, { id: 'maxMode', value: true }], 8000);
  enriched = await enrichToolForPresence(cursorTool);
  assert.equal(enriched.details, 'Model: Claude Opus 5.5');

  db.close();
});

// ---------------------------------------------------------------------------
// 9. Grok Code (bound summary.json via active_sessions.json)
// ---------------------------------------------------------------------------

test('Grok Code reads reasoning_effort from bound session summary.json only', async () => {
  const grokHome = ENV_OVERRIDES.DISCORD_CODING_STATUS_GROK_HOME;
  writeJson(path.join(grokHome, 'models_cache.json'), {
    models: { 'grok-4.7': { info: { name: 'Grok 4.7' } } }
  });
  resetModelLabelCacheForTests();

  const cwd = path.join(root, 'grok-proj');
  fs.mkdirSync(cwd, { recursive: true });
  const summaryFile = path.join(grokHome, 'sessions', encodeURIComponent(path.resolve(cwd)), 'grok-s1', 'summary.json');
  writeJson(path.join(grokHome, 'active_sessions.json'), [{ session_id: 'grok-s1', pid: 44100, cwd }]);

  const grokTool = {
    key: 'process:grokCli',
    providerId: 'grokCli',
    family: 'grok',
    source: 'process',
    model: null,
    details: '',
    state: '',
    processInfo: liveProcessInfo({ pid: 44100 })
  };

  writeJson(summaryFile, { info: { id: 'grok-s1' }, current_model_id: 'grok-4.7', reasoning_effort: 'xhigh' });
  bumpMtime(summaryFile, 1000);
  let enriched = await enrichToolForPresence(grokTool);
  assert.equal(enriched.details, 'Model: Grok 4.7 (XHigh)');

  writeJson(summaryFile, { info: { id: 'grok-s1' }, current_model_id: 'grok-4.7', reasoning_effort: 'high' });
  bumpMtime(summaryFile, 5000);
  enriched = await enrichToolForPresence(grokTool);
  assert.equal(enriched.details, 'Model: Grok 4.7');
});

// ---------------------------------------------------------------------------
// 10. Muse Code (settings.json for proven session, CLI flag, ambiguous stays blank)
// ---------------------------------------------------------------------------

test('Muse Code shows XHigh/Max for a proven session and never labels an ambiguous process', async () => {
  const execUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const sessionFile = path.join(ENV_OVERRIDES.XDG_DATA_HOME, 'muse', 'sessions', '2026', '11', '27', execUuid, 'session.jsonl');
  const startedAt = Date.now();
  writeText(sessionFile, [
    JSON.stringify({
      schema_version: 1,
      stream: { kind: 'session', id: execUuid },
      sequence: 4,
      recorded_at: (startedAt + 10) * 1000,
      payload_type: 'runtime.session.route_facts',
      payload: { kind: 'route_facts', record: { pid: 55100 } }
    }),
    JSON.stringify({
      schema_version: 1,
      stream: { kind: 'session', id: execUuid },
      sequence: 28,
      recorded_at: (startedAt + 1000) * 1000,
      payload_type: 'run.model.configured',
      payload: { kind: 'run_model', record: { model_id: 'muse-spark-1.3' } }
    })
  ].join('\n') + '\n');

  const settingsFile = ENV_OVERRIDES.DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE;
  writeJson(settingsFile, {
    reasoning_effort: 'medium',
    model_reasoning_efforts: { 'muse-spark-1.3': 'xhigh' }
  });
  bumpMtime(settingsFile, 1000);

  const museTool = (extraArgs = '', extraFields = {}) => ({
    key: 'museCli',
    providerId: 'museCli',
    family: 'muse',
    source: 'process',
    model: null,
    details: '',
    state: 'Muse Code',
    processInfo: {
      pid: 55100,
      executablePath: '/usr/local/bin/muse',
      commandLine: `/usr/local/bin/muse exec --session-id ${execUuid}${extraArgs ? ` ${extraArgs}` : ''}`,
      line: `/usr/local/bin/muse exec --session-id ${execUuid}${extraArgs ? ` ${extraArgs}` : ''}`,
      createdAtMs: startedAt
    },
    ...extraFields
  });

  // Per-model effort from settings.json on a proven session
  let enriched = await enrichToolForPresence(museTool());
  assert.equal(enriched.details, 'Model: Muse Spark 1.3 (XHigh)');

  // Explicit CLI flag overrides settings.json
  enriched = await enrichToolForPresence(museTool('--reasoning-effort max'));
  assert.equal(enriched.details, 'Model: Muse Spark 1.3 (Max)');

  // Lower tier in settings.json stays hidden
  writeJson(settingsFile, {
    reasoning_effort: 'medium',
    model_reasoning_efforts: { 'muse-spark-1.3': 'high' }
  });
  bumpMtime(settingsFile, 5000);
  enriched = await enrichToolForPresence(museTool());
  assert.equal(enriched.details, 'Model: Muse Spark 1.3');

  // Unproven / ambiguous process must stay app-only even if settings.json has max
  writeJson(settingsFile, { model: 'muse-spark-1.3', reasoning_effort: 'max' });
  bumpMtime(settingsFile, 9000);
  enriched = await enrichToolForPresence(museTool('', { processAmbiguous: true }));
  assert.equal(enriched.details, '');
});

// ---------------------------------------------------------------------------
// 11. OpenCode (model.json variant)
// ---------------------------------------------------------------------------

test('OpenCode reads per-model variant from model.json and shows only visible tiers', async () => {
  const stateFile = ENV_OVERRIDES.DISCORD_CODING_STATUS_OPENCODE_STATE;
  const cacheFile = ENV_OVERRIDES.DISCORD_CODING_STATUS_OPENCODE_MODELS_CACHE;
  writeJson(cacheFile, {
    anthropic: { models: { 'claude-opus-5-5': { name: 'Claude Opus 5.5' } } }
  });

  const ocTool = {
    key: 'process:opencodeCli',
    providerId: 'opencodeCli',
    family: 'opencode',
    source: 'process',
    model: null,
    details: '',
    state: ''
  };

  const writeOc = (variant, offsetMs) => {
    writeJson(stateFile, {
      recent: [{ providerID: 'anthropic', modelID: 'claude-opus-5-5' }],
      variant: { 'anthropic/claude-opus-5-5': variant }
    });
    bumpMtime(stateFile, offsetMs);
  };

  writeOc('max', 1000);
  assert.equal(parseOpenCodeRecentModel(JSON.parse(fs.readFileSync(stateFile, 'utf8')))?.effort, 'max');
  let enriched = await enrichToolForPresence(ocTool);
  assert.equal(enriched.details, 'Model: Claude Opus 5.5 (Max)');

  writeOc('xhigh', 4000);
  enriched = await enrichToolForPresence(ocTool);
  assert.equal(enriched.details, 'Model: Claude Opus 5.5 (XHigh)');

  writeOc('high', 8000);
  enriched = await enrichToolForPresence(ocTool);
  assert.equal(enriched.details, 'Model: Claude Opus 5.5');
});

// ---------------------------------------------------------------------------
// 12. Pi / generic hook (--effort CLI argument)
// ---------------------------------------------------------------------------

test('Generic hook (--tool pi) records effort and buildPresence formats visible tiers only', async (t) => {
  const { env, stateFile } = createTestEnvironment(t);
  await runCli([
    'hook', '--tool', 'pi', '--surface', 'cli', '--status', 'running',
    '--session-id', 'pi-1', '--cwd', process.cwd(),
    '--model', 'claude-opus-5-5', '--effort', 'ultracode'
  ], env);

  const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(stored.sessions['pi-1'].effort, 'ultracode');

  const ultra = await enrichToolForPresence({
    key: 'state:pi-1',
    providerId: 'piCli',
    family: 'pi',
    source: 'hook',
    model: 'claude-opus-5-5',
    effort: 'ultracode',
    details: '',
    state: ''
  });
  assert.equal(buildPresence(ultra).details, 'Model: claude-opus-5-5 (Ultracode)');
  assert.equal(buildPresence(ultra).state, undefined);

  const high = await enrichToolForPresence({
    key: 'state:pi-2',
    providerId: 'piCli',
    family: 'pi',
    source: 'hook',
    model: 'claude-opus-5-5',
    effort: 'high',
    details: '',
    state: ''
  });
  assert.equal(buildPresence(high).details, 'Model: claude-opus-5-5');
});
