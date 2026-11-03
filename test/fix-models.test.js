'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Every reader below takes its root from the environment; point them all at a
// scratch tree before the modules load.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-models-'));
process.env.DISCORD_CODING_STATUS_STATE_FILE = path.join(root, 'states.json');
process.env.DISCORD_CODING_STATUS_GROK_HOME = path.join(root, 'grok');
process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
process.env.DISCORD_CODING_STATUS_OPENCODE_STATE = path.join(root, 'opencode-state', 'model.json');
process.env.DISCORD_CODING_STATUS_OPENCODE_MODELS_CACHE = path.join(root, 'opencode-cache', 'models.json');
process.env.DISCORD_CODING_STATUS_CURSOR_STATE_DB = path.join(root, 'cursor', 'state.vscdb');
process.env.CODEX_HOME = path.join(root, 'codex');

const { parseCodexCommandLineModel } = require('../dist/providers/codex/model');
const { displayModelLabel, resetModelLabelCacheForTests } = require('../dist/providers/model-label');
const { readGrokProcessModel } = require('../dist/providers/grok/model');
const { readMuseTuiModelForProcess, museSessionCreatedAtMs } = require('../dist/providers/muse/model');
const { readOpenCodeModel, parseOpenCodeRecentModel } = require('../dist/providers/opencode/model');
const { readCursorModel, parseCursorApplicationUser } = require('../dist/providers/cursor/model');
const { readDesktopHostedClaudeModel, claudeDesktopHostPid } = require('../dist/presence');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

test('codex --model on the live process is read, last flag winning', () => {
  const exe = 'C:\\npm\\codex.exe';
  assert.equal(parseCodexCommandLineModel(`${exe} --model gpt-6.2-astra`), 'gpt-6.2-astra');
  assert.equal(parseCodexCommandLineModel(`${exe} -m gpt-6-luna resume`), 'gpt-6-luna');
  assert.equal(parseCodexCommandLineModel(`${exe} --model=gpt-6-sol`), 'gpt-6-sol');
  assert.equal(parseCodexCommandLineModel(`${exe} -c model="gpt-6.1-terra" -c model_reasoning_effort=low`), 'gpt-6.1-terra');
  assert.equal(parseCodexCommandLineModel(`${exe} -m gpt-6-sol --model gpt-6-luna`), 'gpt-6-luna');
  assert.equal(parseCodexCommandLineModel(`${exe} -c model_reasoning_effort=low`), null);
  assert.equal(parseCodexCommandLineModel(`${exe} "fix --model handling"`), null);
  // Windows escaping as CreateProcess passes it.
  assert.equal(parseCodexCommandLineModel(`${exe} -c "model=\\"gpt-6.2-astra\\""`), 'gpt-6.2-astra');
  assert.equal(parseCodexCommandLineModel(`"C:\\Program Files\\codex.exe" --model gpt-6-sol`), 'gpt-6-sol');
  assert.equal(parseCodexCommandLineModel(`${exe}`), null);
  assert.equal(parseCodexCommandLineModel(null), null);
});

test('codex slugs missing from the cached list follow its naming style', () => {
  resetModelLabelCacheForTests();
  writeJson(path.join(process.env.CODEX_HOME, 'models_cache.json'), { models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol' }] });
  assert.equal(displayModelLabel({ family: 'codex', providerId: 'codexCli' }, 'gpt-6.1-sol'), 'GPT-6.1-Sol');
  assert.equal(displayModelLabel({ family: 'codex', providerId: 'codexCli' }, 'gpt-6.2-astra'), 'GPT-6.2-Astra');
  assert.equal(displayModelLabel({ family: 'codex', providerId: 'codexApp' }, 'gpt-6.2-astra'), 'GPT-6.2 Astra');
  assert.equal(displayModelLabel({ family: 'codex', providerId: 'codexCli' }, 'o9-preview'), 'o9-preview');
});

test('a grok.exe is bound to its session through active_sessions.json', () => {
  const grok = process.env.DISCORD_CODING_STATUS_GROK_HOME;
  const cwd = 'C:\\Users\\a';
  const id = '01a1a0ac-e1be-7403-bc82-35823d0d7ac0';
  writeJson(path.join(grok, 'sessions', encodeURIComponent(cwd), id, 'summary.json'), { info: { id }, current_model_id: 'grok-4.7' });
  writeJson(path.join(grok, 'active_sessions.json'), [{ session_id: id, pid: 31420, cwd }]);
  assert.equal(readGrokProcessModel(31420)?.model, 'grok-4.7');
  assert.equal(readGrokProcessModel(999), null);
  // One pid listed twice cannot say which session is on screen.
  writeJson(path.join(grok, 'active_sessions.json'), [{ session_id: id, pid: 31420, cwd }, { session_id: 'other', pid: 31420, cwd }]);
  assert.equal(readGrokProcessModel(31420), null);
  writeJson(path.join(grok, 'active_sessions.json'), '{torn');
  assert.equal(readGrokProcessModel(31420), null);
});

function uuidV7At(ms, tail) {
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18).padEnd(12, '0')}`;
}

function writeMuseSession(id, model) {
  const date = new Date(museSessionCreatedAtMs(id)).toISOString().slice(0, 10).split('-');
  const file = path.join(process.env.XDG_DATA_HOME, 'muse', 'sessions', ...date, id, 'session.jsonl');
  writeJson(file, `${JSON.stringify({ payload_type: 'runtime.session.metadata', payload: { record: { model_id: model } } })}\n`);
  return file;
}

test('an interactive Muse process is bound to the session it opened at startup or later in the TUI', async () => {
  const started = Date.UTC(2026, 10, 3, 9, 9, 54, 419);
  const proc = (extra = {}) => ({ pid: 7228, createdAtMs: started, line: 'muse-bin-1.4.14.exe', commandLine: '"muse-bin-1.4.14.exe"', ...extra });
  const startup = uuidV7At(started + 373, 'abc123def456789012');
  assert.equal(new Date(museSessionCreatedAtMs(startup)).getTime(), started + 373);
  writeMuseSession(startup, 'muse-spark-1.3');
  assert.equal(readMuseTuiModelForProcess(proc())?.model, 'muse-spark-1.3');

  // A headless run never binds through this path.
  assert.equal(readMuseTuiModelForProcess(proc({ pid: 1, commandLine: '"muse-bin.exe" exec "hi"' })), null);
  // A session opened before the process started belongs to an older one.
  assert.equal(readMuseTuiModelForProcess(proc({ pid: 2, createdAtMs: started + 60_000 })), null);

  // A later session binds only once the TUI history lists it after the
  // startup session (history order: the last prompt's session is on screen).
  const later = uuidV7At(started + 120_000, 'fed987cba654321098');
  writeMuseSession(later, 'muse-wonder-1.0');
  assert.equal(readMuseTuiModelForProcess(proc({ pid: 3 }))?.model, 'muse-spark-1.3');
  const history = path.join(process.env.XDG_DATA_HOME, 'muse', 'tui-history.jsonl');
  writeJson(history, `${JSON.stringify({ project: 'C:\\Users\\a', session: later })}\n`);
  assert.equal(readMuseTuiModelForProcess(proc({ pid: 4 }))?.model, 'muse-spark-1.3', 'entries from before this TUI started are not its own');
  fs.appendFileSync(history, `${JSON.stringify({ session: startup })}\n${JSON.stringify({ session: later })}\n`);
  assert.equal(readMuseTuiModelForProcess(proc({ pid: 5 }))?.model, 'muse-wonder-1.0');

  // /resume of an old session: its id is the newest history entry.
  const old = uuidV7At(started - 86_400_000, '111222333444555666');
  writeMuseSession(old, 'muse-spark-1.2');
  fs.appendFileSync(history, `${JSON.stringify({ session: old })}\n`);
  assert.equal(readMuseTuiModelForProcess(proc({ pid: 6 }))?.model, 'muse-spark-1.2');
  // Another process writing `later` again does not move the TUI back to it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.appendFileSync(path.join(path.dirname(writeMuseSession(later, 'muse-wonder-1.0')), 'session.jsonl'), '\n');
  assert.equal(readMuseTuiModelForProcess(proc({ pid: 7 }))?.model, 'muse-spark-1.2');

  // The startup entry scrolling out of the read tail keeps the binding, for a
  // process already anchored and for one first seen afterwards.
  fs.appendFileSync(history, `${JSON.stringify({ session: later })}
`);
  const filler = `${JSON.stringify({ text: 'x'.repeat(2000) })}
`.repeat(100);
  fs.appendFileSync(history, `${filler}${JSON.stringify({ session: later })}
`);
  assert.ok(fs.statSync(history).size > 160_000);
  assert.equal(readMuseTuiModelForProcess(proc({ pid: 9 }))?.model, 'muse-wonder-1.0');
});

test('a Muse exec run started alongside the TUI leaves the startup session unbound', () => {
  const started = Date.UTC(2026, 10, 4, 9, 0, 0, 0);
  writeMuseSession(uuidV7At(started + 400, 'aaa111bbb222ccc333'), 'muse-spark-1.3');
  writeMuseSession(uuidV7At(started + 1_200, 'ddd444eee555fff666'), 'muse-spark-1.3-contributor');
  assert.equal(readMuseTuiModelForProcess({ pid: 8, createdAtMs: started, commandLine: '"muse.exe"', line: 'muse.exe' }), null);
});

test('OpenCode shows its newest picker entry by the name its status bar uses', () => {
  assert.deepEqual(parseOpenCodeRecentModel({ recent: [{ providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' }] }), { providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' });
  assert.equal(parseOpenCodeRecentModel({ recent: [] }), null);
  assert.equal(parseOpenCodeRecentModel({ recent: [{ providerID: 'x' }] }), null);

  writeJson(process.env.DISCORD_CODING_STATUS_OPENCODE_STATE, { recent: [{ providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' }, { providerID: 'openrouter', modelID: 'z-ai/glm-5.3-flash' }] });
  assert.equal(readOpenCodeModel()?.model, 'deepseek-v4.1-flash-free');
  writeJson(process.env.DISCORD_CODING_STATUS_OPENCODE_MODELS_CACHE, { opencode: { models: { 'deepseek-v4.1-flash-free': { name: 'DeepSeek V4.1 Flash Free' } } } });
  assert.equal(readOpenCodeModel()?.model, 'DeepSeek V4.1 Flash Free');
});

let hasSqlite = true;
try {
  require('node:sqlite');
} catch (_) {
  hasSqlite = false;
}

test('Cursor shows the Agent pick the way its input box labels it', { skip: !hasSqlite && 'node:sqlite unavailable' }, () => {
  const user = (modelName) => ({
    aiSettings: { modelConfig: { composer: { modelName } } },
    availableDefaultModels2: [
      { name: 'default', serverModelName: 'default', inputboxShortModelName: 'Auto' },
      { name: 'claude-opus-5-5', serverModelName: 'claude-opus-5-5', inputboxShortModelName: 'Claude Opus 5.5' }
    ]
  });
  assert.equal(parseCursorApplicationUser(user('default')), 'Auto');
  assert.equal(parseCursorApplicationUser(user('claude-opus-5-5')), 'Claude Opus 5.5');
  assert.equal(parseCursorApplicationUser(user('new-model-x')), 'new-model-x');
  assert.equal(parseCursorApplicationUser({ aiSettings: {} }), null);

  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.DISCORD_CODING_STATUS_CURSOR_STATE_DB;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(
    'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
    JSON.stringify(user('claude-opus-5-5'))
  );
  db.close();
  assert.equal(readCursorModel()?.model, 'Claude Opus 5.5');
});

test('Claude Desktop falls back to its Code-tab runners only when they agree', () => {
  const now = Date.now();
  const desktopPid = 23200;
  const exe = 'C:\\Claude\\app\\claude.exe';
  const runner = (pid, args, createdAtMs = now - 60_000) => ({
    pid, ppid: desktopPid, executablePath: exe, createdAtMs,
    line: `${exe} ${args}`, commandLine: `"${exe}" --output-format stream-json --verbose ${args}`
  });
  const writeSessions = (sessions) => writeJson(process.env.DISCORD_CODING_STATUS_STATE_FILE, { version: 1, sessions });
  const session = (id, model, entrypoint = 'claude-desktop', updatedAt = now - 5_000) => ({
    tool: 'claude', surface: 'cli', status: 'running', session_id: id, cwd: root, updated_at: updatedAt, model, claude_entrypoint: entrypoint
  });

  // Flag only: the label is the one Claude writes.
  writeSessions({});
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [runner(1, '--model=claude-opus-5-5')]), 'Opus 5.5');
  // A /model switch reaches the hook of the session the runner resumes.
  writeSessions({ a: session('a91fb3fc-86c8-4c84-8376-9738c7ae6cc0', 'claude-sonnet-5-5') });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [runner(1, '--model=claude-opus-5-5 --resume=a91fb3fc-86c8-4c84-8376-9738c7ae6cc0')]), 'Sonnet 5.5');
  // A resuming runner whose own hook is missing never adopts another one.
  writeSessions({ other: session('other', 'claude-sonnet-5-5') });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [runner(1, '--model=claude-opus-5-5 --resume=a91fb3fc-86c8-4c84-8376-9738c7ae6cc0')]), 'Opus 5.5');
  writeSessions({ a: session('a91fb3fc-86c8-4c84-8376-9738c7ae6cc0', 'claude-sonnet-5-5') });
  // ...and not a hook written before this runner started.
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [runner(1, '--model=claude-opus-5-5 --resume=a91fb3fc-86c8-4c84-8376-9738c7ae6cc0', now)]), 'Opus 5.5');
  // Two tabs on different models: the one on screen is unknown.
  writeSessions({});
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [runner(1, '--model=claude-opus-5-5'), runner(2, '--model=claude-sonnet-5-5')]), null);
  // A terminal session never labels the Desktop.
  writeSessions({ term: session('term', 'claude-sonnet-5-5', 'cli', now) });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [runner(1, '--model=claude-opus-5-5')]), 'Opus 5.5');
  // The one unbound tab takes the one unbound Code-tab hook.
  writeSessions({ fresh: session('fresh', 'claude-haiku-5-5') });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [runner(1, '--model=claude-opus-5-5')]), 'Haiku 5.5');
  // No runner under this Desktop: nothing to borrow.
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [{ ...runner(1, '--model=claude-opus-5-5'), ppid: 1 }]), null);
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [{ ...runner(1, ''), commandLine: `"${exe}" --type=renderer` }]), null);
});

test('the Claude Desktop new-chat draft hook is not a session', () => {
  const { detectStateTools } = require('../dist/presence');
  writeJson(process.env.DISCORD_CODING_STATUS_STATE_FILE, {
    version: 1,
    sessions: {
      'empty-state-draft': { tool: 'claude', surface: 'cli', status: 'running', session_id: 'empty-state-draft', cwd: root, updated_at: Date.now(), model: 'default' }
    }
  });
  assert.deepEqual(detectStateTools(), []);
});

test('a Claude Desktop helper process resolves to its topmost Claude.exe', () => {
  const app = 'C:\\Program Files\\WindowsApps\\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe';
  const main = { pid: 23200, ppid: 11492, executablePath: app, line: app };
  const gpu = { pid: 23928, ppid: 23200, executablePath: app, line: `${app} --type=gpu-process` };
  const shell = { pid: 11492, ppid: 2940, executablePath: 'C:\\Windows\\System32\\sihost.exe', line: 'sihost.exe' };
  assert.equal(claudeDesktopHostPid(gpu, [shell, main, gpu]), 23200);
  assert.equal(claudeDesktopHostPid(main, [shell, main, gpu]), 23200);
  assert.equal(claudeDesktopHostPid({ pid: 5, executablePath: 'C:\\x\\node.exe', line: 'node' }, [main]), null);
});
