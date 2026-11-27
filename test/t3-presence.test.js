'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-t3-'));
const previous = {
  t3Home: process.env.DISCORD_CODING_STATUS_T3_HOME,
  t3Db: process.env.DISCORD_CODING_STATUS_T3_STATE_DB,
  t3Browser: process.env.DISCORD_CODING_STATUS_T3_BROWSER_DATA,
  codexHome: process.env.CODEX_HOME,
  grokHome: process.env.DISCORD_CODING_STATUS_GROK_HOME
};
process.env.DISCORD_CODING_STATUS_T3_HOME = root;
process.env.DISCORD_CODING_STATUS_T3_STATE_DB = path.join(root, 'absent.sqlite');
process.env.DISCORD_CODING_STATUS_T3_BROWSER_DATA = path.join(root, 'browser');
process.env.CODEX_HOME = path.join(root, 'codex-empty');
process.env.DISCORD_CODING_STATUS_GROK_HOME = path.join(root, 'grok-empty');

const { createTestEnvironment, runCli } = require('./helpers');
const { isHostOrAiProcess } = require('../dist/adapters/system/process-cache');
const { detectSetupTools } = require('../dist/adapters/system/installed-tools');
const { displayModelLabel, resetModelLabelCacheForTests } = require('../dist/providers/model-label');
const { resolveDiscordApplications } = require('../dist/providers/discord');
const { DEFAULT_T3_CLIENT_ID, toolProviders } = require('../dist/providers/registry');
const { DEFAULT_T3_IMAGE_KEY, DEFAULT_T3_NIGHTLY_IMAGE_KEY, t3Providers } = require('../dist/providers/t3/provider');
const {
  getT3LocalStorageDirectory,
  getT3WatchStamp,
  readLevelDbLogRecords,
  readT3Presence,
  resetT3ModelCacheForTests
} = require('../dist/providers/t3/model');
const { buildPresence, enrichToolForPresence } = require('../dist/presence');

let hasSqlite = true;
try {
  require('node:sqlite');
} catch (_) {
  hasSqlite = false;
}

function restore(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test.after(() => {
  restore('DISCORD_CODING_STATUS_T3_HOME', previous.t3Home);
  restore('DISCORD_CODING_STATUS_T3_STATE_DB', previous.t3Db);
  restore('DISCORD_CODING_STATUS_T3_BROWSER_DATA', previous.t3Browser);
  restore('CODEX_HOME', previous.codexHome);
  restore('DISCORD_CODING_STATUS_GROK_HOME', previous.grokHome);
  resetModelLabelCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function writeModelLists() {
  writeJson(path.join(root, 'userdata', 'model-manifest.json'), {
    manifest: {
      providers: {
        grok: { models: [{ slug: 'grok-4.7', name: 'Stale Name' }] },
        cursor: { models: [{ slug: 'composer-9', name: 'Composer 9' }] }
      }
    }
  });
  writeJson(path.join(root, 'caches', 'grok.json'), {
    instanceId: 'grok',
    models: [
      { slug: 'grok-4.7', name: 'Grok 4.7' },
      { slug: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast' }
    ]
  });
  writeJson(path.join(root, 'caches', 'broken.json'), '{');
  writeJson(path.join(root, 'caches', 'pi.json'), {
    instanceId: 'pi',
    models: [{ slug: 'default', name: 'Pi Default' }]
  });
  writeJson(path.join(root, 'caches', 'kiro.json'), {
    instanceId: 'kiro',
    models: [{ slug: 'default', name: 'Kiro Default' }]
  });
  writeJson(path.join(root, 'caches', 'fx.json'), {
    instanceId: 'fx',
    models: [
      { slug: 'default', name: 'FX Default' },
      { slug: 'fx-local', name: 'FX Local (Extra High)' }
    ]
  });
  writeJson(path.join(root, 'caches', 'antigravity.json'), {
    instanceId: 'antigravity',
    models: [{ slug: 'gemini-3.8-flash-high', name: 'Not This (High)' }]
  });
  resetModelLabelCacheForTests();
}

function t3Tool() {
  return {
    key: 'process:t3',
    providerId: 't3App',
    family: 't3',
    source: 'process',
    model: null,
    details: '',
    state: 'T3 Code'
  };
}

function useDatabase(name) {
  const file = path.join(root, 'dbs', `${name}.sqlite`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  process.env.DISCORD_CODING_STATUS_T3_STATE_DB = file;
  resetT3ModelCacheForTests();
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
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
  return { file, db };
}

function addSubagents(db) {
  db.exec(`
    CREATE TABLE orchestration_v2_projection_subagents (
      status TEXT,
      child_thread_id TEXT
    );
  `);
}

function addThread(db, row) {
  const payload = {
    modelSelection: {
      instanceId: row.instanceId,
      model: row.model
    }
  };
  if (row.lastVisitedAt) {
    payload.lastVisitedAt = row.lastVisitedAt;
  }
  db.prepare(`
    INSERT INTO orchestration_v2_projection_threads
      (thread_id, payload_json, deleted_at, archived_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    row.id,
    JSON.stringify(payload),
    row.deletedAt || null,
    row.archivedAt || null,
    row.updatedAt
  );
}

function addNode(db, threadId, status, kind = 'root_turn') {
  db.prepare(`
    INSERT INTO orchestration_v2_projection_nodes (thread_id, kind, status)
    VALUES (?, ?, ?)
  `).run(threadId, kind, status);
}

function addSubagent(db, status, child) {
  db.prepare(`
    INSERT INTO orchestration_v2_projection_subagents (status, child_thread_id)
    VALUES (?, ?)
  `).run(status, child);
}

test('T3 keeps an empty Discord application id and its public icon', () => {
  assert.equal(DEFAULT_T3_CLIENT_ID, '');
  assert.ok(toolProviders.some((provider) => provider.id === 't3App'));
  assert.ok(toolProviders.some((provider) => provider.id === 't3Home'));

  const apps = resolveDiscordApplications(toolProviders, (_name, fallback = '') => fallback);
  assert.equal(apps.get('t3').clientId, '');
  assert.equal(apps.get('t3').label, 'T3 Code');
  assert.equal(apps.get('t3').imageKey, DEFAULT_T3_IMAGE_KEY);

  const custom = resolveDiscordApplications(toolProviders, (name, fallback = '') => (
    name === 'DISCORD_CODING_STATUS_T3_CLIENT_ID' ? '100000000000000009' : fallback
  ));
  assert.equal(custom.get('t3').clientId, '100000000000000009');
  assert.equal(custom.get('t3').imageKey, DEFAULT_T3_IMAGE_KEY);
});

test('T3 setup matches the Start menu name and the ~/.t3 path', () => {
  const home = 'C:\\Users\\example';
  for (const startName of ['T3 Code (Beta)', 'T3 Code (Nightly)']) {
    const detections = detectSetupTools({
      platform: 'win32',
      homeDirectory: home,
      pathExists: (candidate) => candidate === `${home}\\.t3`,
      executeFile: (command) => {
        if (command !== 'powershell.exe') {
          throw new Error(`unexpected ${command}`);
        }
        return JSON.stringify([{ Name: startName, AppID: 'com.t3tools.t3code' }]);
      }
    }, t3Providers);

    assert.equal(detections.find((item) => item.key === 't3App').detail, 'shell:AppsFolder\\com.t3tools.t3code');
    assert.equal(detections.find((item) => item.key === 't3Home').detail, `${home}\\.t3`);
  }
});

test('the process census names T3 without treating a t3code folder as the app', () => {
  const processes = fs.readFileSync(path.join(__dirname, '../src/adapters/system/processes.ts'), 'utf8');
  const cache = fs.readFileSync(path.join(__dirname, '../src/adapters/system/process-cache.ts'), 'utf8');
  assert.ok(processes.includes("Name LIKE 'T3 Code (%).exe'"));
  assert.ok(processes.includes("Name='T3 Code.exe'"));
  assert.ok(processes.includes("Name='t3code.exe'"));
  assert.ok(cache.includes('t3 code(?: \\([a-z0-9._ -]+\\))?\\.exe|t3code\\.exe'));
  assert.equal(cache.includes('t3-resource-monitor'), false);

  assert.equal(isHostOrAiProcess({
    line: 'C:\\Programs\\t3code\\T3 Code (Beta).exe'
  }), true);
  assert.equal(isHostOrAiProcess({
    line: 'C:\\Programs\\t3code\\T3 Code (Nightly).exe'
  }), true);
  assert.equal(isHostOrAiProcess({
    line: 'C:\\Programs\\t3code\\Uninstall T3 Code (Nightly).exe'
  }), false);
  assert.equal(isHostOrAiProcess({
    line: 'C:\\Windows\\notepad.exe C:\\work\\t3code\\notes.txt'
  }), false);
  assert.equal(isHostOrAiProcess({
    line: 'C:\\Tools\\t3-resource-monitor.exe'
  }), false);
});

test('T3 Nightly uses the Nightly icon while Beta and Stable keep the standard icon', () => {
  const nightly = buildPresence({
    ...t3Tool(),
    processInfo: {
      pid: 1,
      line: 'C:\\Users\\example\\AppData\\Local\\Programs\\t3code\\T3 Code (Nightly).exe',
      raw: 'C:\\Users\\example\\AppData\\Local\\Programs\\t3code\\T3 Code (Nightly).exe',
      executablePath: 'C:\\Users\\example\\AppData\\Local\\Programs\\t3code\\T3 Code (Nightly).exe'
    }
  });
  const beta = buildPresence({
    ...t3Tool(),
    processInfo: {
      pid: 2,
      line: 'C:\\Users\\example\\AppData\\Local\\Programs\\t3code\\T3 Code (Beta).exe',
      raw: 'C:\\Users\\example\\AppData\\Local\\Programs\\t3code\\T3 Code (Beta).exe',
      executablePath: 'C:\\Users\\example\\AppData\\Local\\Programs\\t3code\\T3 Code (Beta).exe'
    }
  });
  assert.equal(nightly.largeImageKey, DEFAULT_T3_NIGHTLY_IMAGE_KEY);
  assert.equal(beta.largeImageKey, DEFAULT_T3_IMAGE_KEY);
});

test('T3 model labels follow the sibling tool, then T3\'s own list', () => {
  writeModelLists();
  const cases = [
    [{ family: 't3', providerId: 'grok' }, 'grok-4.7', 'Grok 4.7'],
    [{ family: 't3', providerId: 'grok' }, 'grok-4.7-build-fast', 'Grok 4.7 Fast'],
    [{ family: 't3', providerId: 'claudeAgent' }, 'claude-opus-5-5', 'Opus 5.5'],
    [{ family: 't3', providerId: 'codex' }, 'gpt-6.1-sol', 'GPT-6.1 Sol'],
    [{ family: 't3', providerId: 'antigravity' }, 'gemini-3.8-flash-high', 'Gemini 3.8 Flash'],
    [{ family: 't3', providerId: 'muse' }, 'muse-wonder-1.0', 'Muse Wonder 1.0'],
    [{ family: 't3', providerId: 'cursor' }, 'composer-9', 'Composer 9'],
    [{ family: 't3', providerId: 'fx' }, 'fx-local', 'FX Local'],
    [{ family: 't3', providerId: 'pi' }, 'default', 'Pi Default'],
    [{ family: 't3', providerId: 'kiro' }, 'default', 'Kiro Default'],
    [{ family: 't3', providerId: 'fx' }, 'default', 'FX Default'],
    [{ family: 't3' }, 'default', 'default'],
    [{ family: 't3', providerId: 'fx' }, 'brand-new-model', 'brand-new-model']
  ];
  for (const [surface, id, expected] of cases) {
    assert.equal(displayModelLabel(surface, id), expected, `${surface.providerId || 'none'} ${id}`);
  }
});

test('a visited T3 thread beats a newer thread that was never opened', { skip: !hasSqlite && 'node:sqlite unavailable' }, () => {
  const { db } = useDatabase('focus');
  addThread(db, {
    id: 'old-visit',
    instanceId: 'claudeAgent',
    model: 'claude-opus-5-5',
    lastVisitedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  addThread(db, {
    id: 'new-visit',
    instanceId: 'grok',
    model: 'grok-4.7',
    lastVisitedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z'
  });
  addThread(db, {
    id: 'background',
    instanceId: 'codex',
    model: 'gpt-6.1-sol',
    updatedAt: '2026-12-01T00:00:00.000Z'
  });
  db.close();

  const snapshot = readT3Presence();
  assert.equal(snapshot.model, 'grok-4.7');
  assert.equal(snapshot.instanceId, 'grok');
  assert.equal(readT3Presence(), snapshot, 'an unchanged database is not read again');
});

test('with no visited T3 thread, the newest update names the model', { skip: !hasSqlite && 'node:sqlite unavailable' }, () => {
  const { db } = useDatabase('unvisited');
  addThread(db, {
    id: 'older',
    instanceId: 'grok',
    model: 'grok-4.7',
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  addThread(db, {
    id: 'newer',
    instanceId: 'muse',
    model: 'muse-wonder-1.0',
    updatedAt: '2026-08-01T00:00:00.000Z'
  });
  db.close();

  const snapshot = readT3Presence();
  assert.equal(snapshot.model, 'muse-wonder-1.0');
  assert.equal(snapshot.instanceId, 'muse');
});

test('fewer than 3 working T3 agents stay hidden, and 3 or more show count and models', { skip: !hasSqlite && 'node:sqlite unavailable' }, async () => {
  writeModelLists();
  const { db } = useDatabase('agents');
  addSubagents(db);
  addThread(db, {
    id: 'focus',
    instanceId: 'grok',
    model: 'grok-4.7',
    lastVisitedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z'
  });
  for (let index = 1; index <= 2; index += 1) {
    const id = `work-${index}`;
    addThread(db, {
      id,
      instanceId: 'grok',
      model: 'grok-4.7',
      updatedAt: '2026-06-01T00:00:00.000Z'
    });
    addNode(db, id, 'running');
  }
  addNode(db, 'work-1', 'running');
  addNode(db, 'work-1', 'running', 'tool_call');
  addNode(db, 'work-1', 'waiting');
  addThread(db, {
    id: 'gone',
    instanceId: 'grok',
    model: 'grok-4.7',
    updatedAt: '2026-06-01T00:00:00.000Z',
    deletedAt: '2026-06-02T00:00:00.000Z'
  });
  addNode(db, 'gone', 'running');
  addThread(db, {
    id: 'shelf',
    instanceId: 'grok',
    model: 'grok-4.7',
    updatedAt: '2026-06-01T00:00:00.000Z',
    archivedAt: '2026-06-02T00:00:00.000Z'
  });
  addNode(db, 'shelf', 'starting');
  addSubagent(db, 'running', 'work-1');
  addSubagent(db, 'waiting', null);
  db.close();

  resetT3ModelCacheForTests();
  const hidden = readT3Presence();
  assert.equal(hidden.workingAgents, 2);
  const quiet = await enrichToolForPresence(t3Tool());
  assert.equal(quiet.details, 'Model: Grok 4.7');
  assert.equal(quiet.state, '');
  assert.equal(buildPresence(quiet).state, undefined);

  const { DatabaseSync } = require('node:sqlite');
  const again = new DatabaseSync(process.env.DISCORD_CODING_STATUS_T3_STATE_DB);
  addSubagent(again, 'running', null);
  again.close();
  resetT3ModelCacheForTests();

  const shown = await enrichToolForPresence(t3Tool());
  assert.equal(shown.details, 'Model: Grok 4.7');
  assert.equal(shown.state, '3 agents · 2x Grok 4.7');
  assert.equal(buildPresence(shown).state, '3 agents · 2x Grok 4.7');
});

test('3+ working T3 agents exclude focused main model from bottom line, keep orchestrating parent active, and ignore subagent threads for top Model:', { skip: !hasSqlite && 'node:sqlite unavailable' }, async () => {
  writeModelLists();
  const { db } = useDatabase('mixed-agents');
  db.exec(`
    CREATE TABLE orchestration_v2_projection_runs (
      thread_id TEXT,
      ordinal INTEGER,
      provider TEXT,
      provider_instance_id TEXT,
      status TEXT,
      payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_subagents (
      thread_id TEXT,
      status TEXT,
      child_thread_id TEXT,
      provider TEXT,
      provider_instance_id TEXT,
      payload_json TEXT
    );
  `);
  addThread(db, {
    id: 'main',
    instanceId: 'antigravity',
    model: 'gemini-4-neon',
    lastVisitedAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z'
  });
  // Delegated subagent threads have newer lastVisitedAt & subagent lineage; they must NEVER hijack the top Model: line!
  db.prepare(`
    INSERT INTO orchestration_v2_projection_threads (thread_id, payload_json, deleted_at, archived_at, updated_at)
    VALUES (?, ?, NULL, NULL, ?)
  `).run(
    'thread:delegated-task:child-1',
    JSON.stringify({
      modelSelection: { instanceId: 'antigravity', model: 'claude-opus-5-5' },
      lastVisitedAt: '2026-06-02T00:05:00.000Z',
      lineage: { parentThreadId: 'main', relationshipToParent: 'subagent', rootThreadId: 'main' }
    }),
    '2026-06-02T00:05:00.000Z'
  );
  db.prepare(`
    INSERT INTO orchestration_v2_projection_threads (thread_id, payload_json, deleted_at, archived_at, updated_at)
    VALUES (?, ?, NULL, NULL, ?)
  `).run(
    'thread:delegated-task:child-2',
    JSON.stringify({
      modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
      lastVisitedAt: '2026-06-02T00:06:00.000Z',
      lineage: { parentThreadId: 'main', relationshipToParent: 'subagent', rootThreadId: 'main' }
    }),
    '2026-06-02T00:06:00.000Z'
  );
  // Main thread's own run is completed (waiting for children), while its 2 subagents are running!
  db.prepare(`
    INSERT INTO orchestration_v2_projection_runs (thread_id, ordinal, provider, provider_instance_id, status, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('main', 1, 'antigravity', 'antigravity', 'completed', JSON.stringify({ modelSelection: { instanceId: 'antigravity', model: 'gemini-4-neon' } }));
  db.prepare(`
    INSERT INTO orchestration_v2_projection_runs (thread_id, ordinal, provider, provider_instance_id, status, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('thread:delegated-task:child-1', 1, 'antigravity', 'antigravity', 'running', JSON.stringify({ modelSelection: { instanceId: 'antigravity', model: 'claude-opus-5-5' } }));
  db.prepare(`
    INSERT INTO orchestration_v2_projection_runs (thread_id, ordinal, provider, provider_instance_id, status, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('thread:delegated-task:child-2', 1, 'claudeAgent', 'claudeAgent', 'running', JSON.stringify({ modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } }));
  db.prepare(`
    INSERT INTO orchestration_v2_projection_subagents (thread_id, status, child_thread_id, provider, provider_instance_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('main', 'running', 'thread:delegated-task:child-1', 'antigravity', 'antigravity', JSON.stringify({ modelSelection: { instanceId: 'antigravity', model: 'claude-opus-5-5' } }));
  db.prepare(`
    INSERT INTO orchestration_v2_projection_subagents (thread_id, status, child_thread_id, provider, provider_instance_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('main', 'running', 'thread:delegated-task:child-2', 'claudeAgent', 'claudeAgent', JSON.stringify({ modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } }));
  db.close();

  resetT3ModelCacheForTests();
  const threeOrchestrated = await enrichToolForPresence(t3Tool());
  // Top line stays Gemini 4 Neon (subagent threads ignored); bottom line counts 3 (main + 2 children),
  // excludes main Gemini 4 Neon, and merges claude-opus-5-5 across antigravity + claudeAgent into 2x Opus 5.5!
  assert.equal(threeOrchestrated.details, 'Model: Gemini 4 Neon');
  assert.equal(threeOrchestrated.state, '3 agents · 2x Opus 5.5');

  // Add a Codex unthreaded subagent so count becomes 4 with GPT-6.2 Sol + 2x Opus 5.5
  const { DatabaseSync } = require('node:sqlite');
  const db2 = new DatabaseSync(process.env.DISCORD_CODING_STATUS_T3_STATE_DB);
  db2.prepare(`
    INSERT INTO orchestration_v2_projection_subagents (thread_id, status, child_thread_id, provider, provider_instance_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('main', 'running', null, 'codex', 'codex', JSON.stringify({ modelSelection: { instanceId: 'codex', model: 'gpt-6.2-sol' } }));
  db2.close();

  resetT3ModelCacheForTests();
  const fourGrouped = await enrichToolForPresence(t3Tool());
  assert.equal(fourGrouped.state, '4 agents · 2x Opus 5.5, GPT-6.2 Sol');
});

test('a T3 model still shows when the subagent table is missing', { skip: !hasSqlite && 'node:sqlite unavailable' }, async () => {
  writeModelLists();
  const { db } = useDatabase('no-subagents');
  addThread(db, {
    id: 'focus',
    instanceId: 'claudeAgent',
    model: 'claude-opus-5-5',
    lastVisitedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z'
  });
  for (let index = 1; index <= 3; index += 1) {
    const id = `work-${index}`;
    addThread(db, {
      id,
      instanceId: 'claudeAgent',
      model: 'claude-opus-5-5',
      updatedAt: '2026-06-01T00:00:00.000Z'
    });
    addNode(db, id, 'pending');
  }
  db.close();

  const snapshot = readT3Presence();
  assert.equal(snapshot.model, 'claude-opus-5-5');
  assert.equal(snapshot.workingAgents, 3);
  const enriched = await enrichToolForPresence(t3Tool());
  assert.equal(enriched.details, 'Model: Opus 5.5');
  assert.equal(enriched.state, '3 agents · 3x Opus 5.5');
});

test('three working T3 agents still count when no model can be proven', { skip: !hasSqlite && 'node:sqlite unavailable' }, async () => {
  const { db } = useDatabase('count-only');
  for (let index = 1; index <= 3; index += 1) {
    const id = `work-${index}`;
    addThread(db, {
      id,
      instanceId: 'grok',
      model: 'not a model',
      updatedAt: '2026-06-01T00:00:00.000Z'
    });
    addNode(db, id, 'queued');
  }
  db.close();

  const snapshot = readT3Presence();
  assert.equal(snapshot.model, null);
  assert.equal(snapshot.workingAgents, 3);
  const enriched = await enrichToolForPresence(t3Tool());
  assert.equal(enriched.details, '');
  assert.equal(enriched.state, '3 agents');
});

test('a locked or broken T3 database keeps the last proven snapshot', { skip: !hasSqlite && 'node:sqlite unavailable' }, () => {
  const { file, db } = useDatabase('sticky');
  addThread(db, {
    id: 'focus',
    instanceId: 'grok',
    model: 'grok-4.7',
    lastVisitedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z'
  });
  db.close();

  const first = readT3Presence();
  assert.equal(first.model, 'grok-4.7');
  fs.writeFileSync(file, 'not a database');
  const second = readT3Presence();
  assert.equal(second, first);
  fs.rmSync(file, { force: true });
  assert.equal(readT3Presence(), null);
});

// ---- composer drafts (Chromium localStorage in a LevelDB write-ahead log) ----

const DRAFTS_KEY = Buffer.concat([
  Buffer.from('_t3code://app', 'latin1'),
  Buffer.from([0, 1]),
  Buffer.from('t3code:composer-drafts:v1', 'latin1')
]);

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function writeBatch(sequence, value) {
  const header = Buffer.alloc(12);
  header.writeBigUInt64LE(BigInt(sequence), 0);
  header.writeUInt32LE(1, 8);
  if (value === null) {
    return Buffer.concat([header, Buffer.from([0]), varint(DRAFTS_KEY.length), DRAFTS_KEY]);
  }
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  const utf16 = /[^\u0000-ÿ]/.test(encoded);
  const stored = Buffer.concat([
    Buffer.from([utf16 ? 0 : 1]),
    Buffer.from(encoded, utf16 ? 'utf16le' : 'latin1')
  ]);
  return Buffer.concat([
    header,
    Buffer.from([1]),
    varint(DRAFTS_KEY.length),
    DRAFTS_KEY,
    varint(stored.length),
    stored
  ]);
}

function maskedCrc32c(type, data) {
  let crc = 0xffffffff;
  for (const byte of [type, ...data]) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    }
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
}

// Frames batches into 32 KiB blocks the way LevelDB does (FULL/FIRST/MIDDLE/LAST).
function frameLog(batches) {
  const blocks = [];
  let block = Buffer.alloc(0);
  const flush = () => {
    blocks.push(Buffer.concat([block, Buffer.alloc(32768 - block.length)]));
    block = Buffer.alloc(0);
  };
  for (const batch of batches) {
    let rest = batch;
    let first = true;
    while (true) {
      if (32768 - block.length < 7) {
        flush();
      }
      const room = 32768 - block.length - 7;
      const piece = rest.subarray(0, room);
      rest = rest.subarray(piece.length);
      const type = first ? (rest.length ? 2 : 1) : (rest.length ? 3 : 4);
      const header = Buffer.alloc(7);
      header.writeUInt32LE(maskedCrc32c(type, piece), 0);
      header.writeUInt16LE(piece.length, 4);
      header[6] = type;
      block = Buffer.concat([block, header, piece]);
      first = false;
      if (!rest.length) {
        break;
      }
    }
  }
  return Buffer.concat([...blocks, block]);
}

let drafts = [];

function writeDrafts(value, { mtime } = {}) {
  const directory = getT3LocalStorageDirectory();
  fs.mkdirSync(directory, { recursive: true });
  drafts.push(writeBatch(drafts.length + 1, value));
  const file = path.join(directory, '000010.log');
  fs.writeFileSync(file, frameLog(drafts));
  if (mtime) {
    fs.utimesSync(file, mtime, mtime);
  }
}

function resetDrafts() {
  drafts = [];
  fs.rmSync(path.join(root, 'browser'), { recursive: true, force: true });
}

function draftState(entries, sticky = {}) {
  return {
    state: {
      draftsByThreadKey: entries.drafts || {},
      draftThreadsByThreadKey: entries.newThreads || {},
      stickyModelSelectionByProvider: sticky,
      stickyActiveProvider: 'claudeAgent'
    },
    version: 9
  };
}

function focusDatabase(name) {
  const { db } = useDatabase(name);
  addThread(db, {
    id: 'thread-a',
    instanceId: 'grok',
    model: 'grok-4.7',
    lastVisitedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z'
  });
  db.close();
}

test('a pick in a new, unsent T3 thread shows at once and gives way after it is sent', { skip: !hasSqlite && 'node:sqlite unavailable' }, async () => {
  writeModelLists();
  resetDrafts();
  focusDatabase('draft-focus');
  writeDrafts(draftState({}));
  assert.equal(readT3Presence().model, 'grok-4.7');

  const newThread = { threadId: 'thread-new', promotedTo: null };
  writeDrafts(draftState({
    drafts: { 'draft-1': { prompt: 'secret words', modelSelectionByProvider: {
      claudeAgent: { instanceId: 'claudeAgent', model: 'claude-haiku-5-5' }
    }, activeProvider: 'claudeAgent' } },
    newThreads: { 'draft-1': newThread }
  }));
  const picked = readT3Presence();
  assert.deepEqual(picked, { model: 'claude-haiku-5-5', instanceId: 'claudeAgent', workingAgents: 0 });
  assert.equal(JSON.stringify(picked).includes('secret'), false);

  writeDrafts(draftState({
    drafts: { 'draft-1': { modelSelectionByProvider: {
      claudeAgent: { instanceId: 'claudeAgent', model: 'claude-haiku-5-5' },
      codex: { instanceId: 'codex', model: 'gpt-6.1-sol' }
    }, activeProvider: 'codex' } },
    newThreads: { 'draft-1': newThread }
  }));
  const enriched = await enrichToolForPresence(t3Tool());
  assert.equal(enriched.details, 'Model: GPT-6.1 Sol');

  // Sent: T3 marks the draft promoted, so the database row names the model again.
  writeDrafts(draftState({
    drafts: { 'draft-1': { activeProvider: 'codex', modelSelectionByProvider: {} } },
    newThreads: { 'draft-1': { threadId: 'thread-new', promotedTo: 'thread-new' } }
  }));
  assert.equal(readT3Presence().model, 'grok-4.7');
});

test('a T3 pick older than the last visit does not take over the screen', { skip: !hasSqlite && 'node:sqlite unavailable' }, () => {
  resetDrafts();
  focusDatabase('draft-stale');
  const old = new Date('2026-05-01T00:00:00.000Z');
  writeDrafts(draftState({}), { mtime: old });
  readT3Presence();
  writeDrafts(draftState({
    drafts: { 'draft-1': { activeProvider: 'claudeAgent', modelSelectionByProvider: {
      claudeAgent: { instanceId: 'claudeAgent', model: 'claude-haiku-5-5' }
    } } },
    newThreads: { 'draft-1': { threadId: 'thread-new', promotedTo: null } }
  }), { mtime: old });
  assert.equal(readT3Presence().model, 'grok-4.7');
});

test('an unsent provider switch on the T3 thread on screen shows on the first read', { skip: !hasSqlite && 'node:sqlite unavailable' }, () => {
  resetDrafts();
  focusDatabase('draft-pending');
  writeDrafts(draftState({
    drafts: {
      'env-1:thread-a': { activeProvider: 'claudeAgent', modelSelectionByProvider: {
        claudeAgent: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }
      } },
      'env-1:thread-other': { activeProvider: 'codex', modelSelectionByProvider: {
        codex: { instanceId: 'codex', model: 'gpt-6.1-sol' }
      } }
    }
  }));
  assert.deepEqual(readT3Presence(), { model: 'claude-opus-5-5', instanceId: 'claudeAgent', workingAgents: 0 });

  // Deleted key: no drafts, back to the thread's own model.
  writeDrafts(null);
  assert.equal(readT3Presence().model, 'grok-4.7');
});

test('the LevelDB log reader joins records split across blocks and reads UTF-16 values', { skip: !hasSqlite && 'node:sqlite unavailable' }, () => {
  resetDrafts();
  focusDatabase('draft-split');
  writeDrafts(draftState({}));
  readT3Presence();
  const long = 'ق'.repeat(40000);
  writeDrafts(draftState({
    drafts: { 'draft-1': { prompt: long, activeProvider: 'grok', modelSelectionByProvider: {
      grok: { instanceId: 'grok', model: 'grok-4.7-build-fast' }
    } } },
    newThreads: { 'draft-1': { threadId: 'thread-new', promotedTo: null } }
  }));
  const file = path.join(getT3LocalStorageDirectory(), '000010.log');
  const records = readLevelDbLogRecords(fs.readFileSync(file));
  assert.equal(records.length, 2);
  assert.ok(records[1].length > 80000, 'the long batch was reassembled whole');
  assert.equal(readT3Presence().model, 'grok-4.7-build-fast');
  resetDrafts();
});

test('a T3 draft record with a bad checksum or a short batch count is ignored', { skip: !hasSqlite && 'node:sqlite unavailable' }, () => {
  resetDrafts();
  focusDatabase('draft-corrupt');
  writeDrafts(draftState({}));
  readT3Presence();
  const file = path.join(getT3LocalStorageDirectory(), '000010.log');
  const good = fs.readFileSync(file);
  const pick = (model) => draftState({
    drafts: { 'draft-1': { activeProvider: 'claudeAgent', modelSelectionByProvider: {
      claudeAgent: { instanceId: 'claudeAgent', model }
    } } },
    newThreads: { 'draft-1': { threadId: 'thread-new', promotedTo: null } }
  });

  // Checksum broken: the scan stops there, so the pick never shows.
  const corrupt = frameLog([...drafts, writeBatch(9, pick('claude-haiku-5-5'))]);
  corrupt[good.length] ^= 0xff;
  fs.writeFileSync(file, corrupt);
  assert.equal(readT3Presence().model, 'grok-4.7');

  // Header says two entries, the batch holds one: the whole batch is dropped.
  resetDrafts();
  focusDatabase('draft-count');
  writeDrafts(draftState({}));
  readT3Presence();
  const short = writeBatch(9, pick('claude-haiku-5-5'));
  short.writeUInt32LE(2, 8);
  fs.writeFileSync(file, frameLog([...drafts, short]));
  assert.equal(readT3Presence().model, 'grok-4.7');

  // Positive control: the same pick, well-formed and appended after it, does show.
  fs.writeFileSync(file, frameLog([...drafts, short, writeBatch(10, pick('claude-haiku-5-5'))]));
  assert.equal(readT3Presence().model, 'claude-haiku-5-5');
  resetDrafts();
});

test('a missing T3 database leaves the card without a model', async () => {
  process.env.DISCORD_CODING_STATUS_T3_STATE_DB = path.join(root, 'missing-on-purpose.sqlite');
  resetT3ModelCacheForTests();
  assert.equal(readT3Presence(), null);
  const enriched = await enrichToolForPresence(t3Tool());
  assert.equal(enriched.details, '');
  assert.equal(enriched.state, '');
});

test('hooks fired by T3-hosted agent turns or agy acp do not write standalone sessions', async (t) => {
  const { env, stateFile } = createTestEnvironment(t);
  const payload = JSON.stringify({
    conversationId: 'conv-acp-1',
    cwd: process.cwd(),
    modelName: 'gemini-4-neon-high'
  });

  const acpResult = await runCli(
    ['antigravity-hook', '--event', 'PreInvocation'],
    { ...env, AGY_ACP_FORCE_FILE_STORAGE: '1' },
    15000,
    payload
  );
  assert.equal(acpResult.stdout.trim(), '{}');
  assert.equal(fs.existsSync(stateFile), false);

  const t3Result = await runCli(
    ['claude-hook', '--event', 'PreToolUse'],
    { ...env, T3CODE_THREAD_ID: '381a5a95-bde8-4ed6-93b4-cd45d80c86b8' },
    15000,
    JSON.stringify({ session_id: 'claude-in-t3', cwd: process.cwd(), model: 'claude-opus-5-5' })
  );
  assert.equal(t3Result.stdout, '');
  assert.equal(fs.existsSync(stateFile), false);

  // Positive control: a standalone Antigravity hook still writes its session.
  const standalone = await runCli(
    ['antigravity-hook', '--event', 'PreInvocation'],
    env,
    15000,
    payload
  );
  assert.equal(standalone.stdout.trim(), '{}');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.sessions['conv-acp-1'].tool, 'antigravity');
});

test('T3 uses the indexed runs table when present and getT3WatchStamp tracks draft log writes', { skip: !hasSqlite && 'node:sqlite unavailable' }, () => {
  resetDrafts();
  const { db } = useDatabase('runs-fast-path');
  addSubagents(db);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_runs (
      thread_id TEXT,
      status TEXT
    );
  `);
  addThread(db, {
    id: 't-1',
    instanceId: 'grok',
    model: 'grok-4.7',
    lastVisitedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z'
  });
  for (const [id, status] of [
    ['t-1', 'running'],
    ['t-2', 'queued'],
    ['t-3', 'preparing'],
    ['t-4', 'starting'],
    ['t-5', 'waiting']
  ]) {
    if (id !== 't-1') {
      addThread(db, {
        id,
        instanceId: 'grok',
        model: 'grok-4.7',
        updatedAt: '2026-06-01T00:00:00.000Z'
      });
    }
    db.prepare('INSERT INTO orchestration_v2_projection_runs (thread_id, status) VALUES (?, ?)').run(id, status);
  }
  addSubagent(db, 'running', 't-1'); // already counted via runs
  addSubagent(db, 'running', null);  // extra agent -> total 5
  db.close();

  const snapshot = readT3Presence();
  assert.equal(snapshot.workingAgents, 5);

  const before = getT3WatchStamp();
  writeDrafts(draftState({}));
  const after = getT3WatchStamp();
  assert.notEqual(after, before);
  resetDrafts();
});
