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
process.env.DISCORD_CODING_STATUS_CLAUDE_DESKTOP_SESSIONS = path.join(root, 'claude-desktop-sessions');

const { parseCodexCommandLineModel } = require('../dist/providers/codex/model');
const { displayModelLabel, resetModelLabelCacheForTests } = require('../dist/providers/model-label');
const { readGrokProcessModel } = require('../dist/providers/grok/model');
const { readMuseTuiModelForProcess, museSessionCreatedAtMs } = require('../dist/providers/muse/model');
const { readOpenCodeModel, parseOpenCodeRecentModel } = require('../dist/providers/opencode/model');
const { readCursorModel, parseCursorApplicationUser } = require('../dist/providers/cursor/model');
const { readDesktopHostedClaudeModel, claudeDesktopHostPid } = require('../dist/presence');
const { readLastUsedClaudeDesktopSession } = require('../dist/providers/claude/desktop-sessions');

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

test('Claude Desktop shows the session last used, whatever idle sessions run', (t) => {
  const now = Date.now();
  const desktopPid = 23200;
  const exe = 'C:\\Claude\\app\\claude.exe';
  const sessionsDir = path.join(process.env.DISCORD_CODING_STATUS_CLAUDE_DESKTOP_SESSIONS, 'account', 'organization');
  const runner = (pid, args, createdAtMs = now - 60_000) => ({
    pid, ppid: desktopPid, executablePath: exe, createdAtMs,
    line: `${exe} ${args}`, commandLine: `"${exe}" --output-format stream-json --verbose ${args}`
  });
  const writeHooks = (sessions) => writeJson(process.env.DISCORD_CODING_STATUS_STATE_FILE, { version: 1, sessions });
  const hook = (id, model, updatedAt = now - 5_000) => ({
    tool: 'claude', surface: 'cli', status: 'running', session_id: id, cwd: root, updated_at: updatedAt, model, claude_entrypoint: 'claude-desktop'
  });
  // Each write gets a new mtime, as a real Desktop save does.
  let tick = 0;
  const record = (name, fields) => {
    const file = path.join(sessionsDir, `local_${name}.json`);
    writeJson(file, fields);
    tick += 1;
    fs.utimesSync(file, new Date(now + tick * 1000), new Date(now + tick * 1000));
  };
  const idleSonnet = runner(1, '--model=claude-sonnet-5-5');
  const activeOpus = runner(2, '--model=claude-opus-5-5 --resume=active');

  // Alone, the two runners disagree and nothing can be shown.
  writeHooks({});
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet, activeOpus]), null);

  record('idle', { cliSessionId: 'idle', model: 'claude-sonnet-5-5', latestUserFrameAt: now - 86_400_000 });
  record('active', { cliSessionId: 'active', model: 'claude-opus-5-5', latestUserFrameAt: now - 5_000 });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet, activeOpus]), 'Opus 5.5');

  // Opening a session without typing in it counts as using it.
  record('idle', { cliSessionId: 'idle', model: 'claude-sonnet-5-5', lastFocusedAt: now - 1_000, latestUserFrameAt: now - 86_400_000 });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet, activeOpus]), 'Sonnet 5.5');
  record('idle', { cliSessionId: 'idle', model: 'claude-sonnet-5-5', latestUserFrameAt: now - 86_400_000 });

  // An archived session never names the model.
  record('archived', { cliSessionId: 'archived', model: 'claude-haiku-5-5', latestUserFrameAt: now, isArchived: true });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet, activeOpus]), 'Opus 5.5');

  // A /model switch reaches the session's hook; another session's hook never counts.
  writeHooks({ a: hook('active', 'claude-haiku-5-5'), b: hook('idle', 'claude-fable-5-1', now) });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet, activeOpus]), 'Haiku 5.5');
  // A hook older than the runner belongs to an earlier one, so the record stands.
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet, runner(2, '--model=claude-opus-5-5 --resume=active', now)]), 'Opus 5.5');

  // A record with no model takes its runner's flag.
  writeHooks({});
  record('active', { cliSessionId: 'active', latestUserFrameAt: now - 4_000 });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet, activeOpus]), 'Opus 5.5');
  // With no model anywhere for that session, an idle session never stands in.
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), null);

  // A file caught mid-write may be the session in use, so an older one never stands in.
  record('active', '{"cliSessionId":"act');
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), null);
  // The failure is not remembered: the same mtime is read again.
  const activeFile = path.join(sessionsDir, 'local_active.json');
  const stamp = fs.statSync(activeFile).mtime;
  writeJson(activeFile, { cliSessionId: 'active', model: 'claude-opus-5-5', latestUserFrameAt: now - 3_000 });
  fs.utimesSync(activeFile, stamp, stamp);
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), 'Opus 5.5');
  // A broken file older than the session in use changes nothing.
  writeJson(path.join(sessionsDir, 'local_broken.json'), '{');
  fs.utimesSync(path.join(sessionsDir, 'local_broken.json'), new Date(now - 60_000), new Date(now - 60_000));
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), 'Opus 5.5');
  fs.rmSync(path.join(sessionsDir, 'local_broken.json'));
  // A record that cannot even be stat'ed may be the session in use.
  const realStat = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...rest) => {
    if (String(file).endsWith('local_active.json')) {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return realStat(file, ...rest);
  });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), null);
  fs.statSync.mock.restore();
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), 'Opus 5.5');

  // A runner started with --session-id is bound as well: its older hook does not count.
  writeHooks({ a: hook('active', 'claude-haiku-5-5') });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [runner(2, '--model=claude-opus-5-5 --session-id=active', now)]), 'Opus 5.5');
  writeHooks({});

  // Equal stamps on different models name nothing; on one model they do.
  record('idle', { cliSessionId: 'idle', model: 'claude-sonnet-5-5', latestUserFrameAt: now - 3_000 });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), null);
  record('idle', { cliSessionId: 'idle', model: 'claude-opus-5-5', latestUserFrameAt: now - 3_000 });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), 'Opus 5.5');
  // Two records with no model cannot be said to agree, whatever their runners say.
  record('active', { cliSessionId: 'active', latestUserFrameAt: now - 3_000 });
  record('idle', { cliSessionId: 'idle', latestUserFrameAt: now - 3_000 });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet, activeOpus]), null);

  // A message delivered to a session the user left: it may be a subagent's report.
  record('active', { cliSessionId: 'active', model: 'claude-opus-5-5', lastFocusedAt: now - 60_000, latestUserFrameAt: now - 50_000 });
  record('idle', { cliSessionId: 'idle', model: 'claude-sonnet-5-5', lastFocusedAt: now - 70_000, latestUserFrameAt: now - 2_000 });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), null);
  // On the same model it makes no difference.
  record('idle', { cliSessionId: 'idle', model: 'claude-opus-5-5', lastFocusedAt: now - 70_000, latestUserFrameAt: now - 2_000 });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), 'Opus 5.5');
  // Two sessions from one view change may both be on screen: the newest message names one.
  record('idle', { cliSessionId: 'idle', model: 'claude-sonnet-5-5', lastFocusedAt: now - 60_500, latestUserFrameAt: now - 2_000 });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), 'Sonnet 5.5');

  // A session that has not run yet has no Claude Code id, and its record still counts.
  record('new', { model: 'claude-fable-5-1', lastFocusedAt: now });
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), 'Fable 5.1');

  // No Code-tab runner under this Desktop: a record alone names nothing.
  assert.equal(readDesktopHostedClaudeModel(desktopPid, []), null);

  // With only an unreadable record, the runners do not decide either.
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  writeJson(path.join(sessionsDir, 'local_only.json'), '{');
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [idleSonnet]), null);
  fs.rmSync(process.env.DISCORD_CODING_STATUS_CLAUDE_DESKTOP_SESSIONS, { recursive: true, force: true });
});

test('Claude Desktop records are read from AppData and from the Store package', (t) => {
  const saved = {
    DISCORD_CODING_STATUS_CLAUDE_DESKTOP_SESSIONS: process.env.DISCORD_CODING_STATUS_CLAUDE_DESKTOP_SESSIONS,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA
  };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
  delete process.env.DISCORD_CODING_STATUS_CLAUDE_DESKTOP_SESSIONS;
  process.env.APPDATA = path.join(root, 'roaming');
  process.env.LOCALAPPDATA = path.join(root, 'local');
  const folder = path.join('Claude', 'claude-code-sessions', 'account', 'organization');

  assert.equal(readLastUsedClaudeDesktopSession(), null);
  writeJson(path.join(process.env.APPDATA, folder, 'local_1.json'), { cliSessionId: 'appdata', latestUserFrameAt: 1_000 });
  assert.equal(readLastUsedClaudeDesktopSession()?.sessionId, 'appdata');
  writeJson(path.join(process.env.LOCALAPPDATA, 'Packages', 'Claude_test', 'LocalCache', 'Roaming', folder, 'local_2.json'), { cliSessionId: 'store', latestUserFrameAt: 2_000 });
  assert.equal(readLastUsedClaudeDesktopSession()?.sessionId, 'store');

  // A running Desktop names its own data folder, even with an older stamp there.
  const dataDir = path.join(root, 'claude-data', 'claude_test');
  writeJson(path.join(dataDir, 'claude-code-sessions', 'account', 'organization', 'local_3.json'), { cliSessionId: 'running', latestUserFrameAt: 500 });
  const running = (exe, args) => [{ pid: 9, ppid: 1, executablePath: exe, commandLine: `"${exe}" ${args}`, line: `${exe} ${args}` }];
  const desktopExe = 'C:\\Claude\\app\\Claude.exe';
  assert.equal(readLastUsedClaudeDesktopSession(running(desktopExe, `--type=renderer --user-data-dir="${dataDir}" --lang=en`))?.sessionId, 'running');
  assert.equal(readLastUsedClaudeDesktopSession(running(desktopExe, `--type=gpu-process --user-data-dir=${dataDir} --lang=en`))?.sessionId, 'running');
  // Another Electron app's data folder is not Claude's, and a helper without the flag says nothing.
  assert.equal(readLastUsedClaudeDesktopSession(running('C:\\Discord\\Discord.exe', `--user-data-dir=${dataDir}`))?.sessionId, 'store');
  assert.equal(readLastUsedClaudeDesktopSession(running(desktopExe, '--type=utility'))?.sessionId, 'store');
});

test('an idle CLI under the focused window still counts as active and wins its provider', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_793_700_000_000 });
  const { detectActiveTools, processTreePids } = require('../dist/core/detection/active-tools');
  const { toolProviders } = require('../dist/providers/registry');
  const started = Date.now() - 3_600_000;
  const shell = { pid: 48352, ppid: 12936, line: 'pwsh.exe', executablePath: 'C:\\pwsh\\pwsh.exe', cpuMs: 10, createdAtMs: started };
  const node = { pid: 48612, ppid: 48352, line: 'node.exe codex.js', executablePath: 'C:\\node\\node.exe', cpuMs: 10, createdAtMs: started + 1_000 };
  const codex = { pid: 50644, ppid: 48612, line: 'C:\\npm\\codex.exe --model gpt-6.2-astra', executablePath: 'C:\\npm\\codex.exe', commandLine: '"C:\\npm\\codex.exe" --model gpt-6.2-astra', cpuMs: 10, createdAtMs: started + 2_000 };
  const busy = { pid: 60000, ppid: 1, line: 'C:\\npm\\codex.exe', executablePath: 'C:\\npm\\codex.exe', commandLine: '"C:\\npm\\codex.exe"', cpuMs: 10, createdAtMs: started };
  const options = (extra = {}) => ({ idleGraceMs: 5 * 60_000, activeCpuMs: 50, ...extra });
  const codexCli = (tools) => tools.find((tool) => tool.providerId === 'codexCli');

  assert.deepEqual([...processTreePids(48352, [shell, node, codex])].sort(), [48352, 48612, 50644]);
  // Seed the CPU tracker, then go idle past the five-minute grace.
  detectActiveTools([shell, node, codex], toolProviders, options());
  t.mock.timers.tick(6 * 60_000);
  assert.equal(codexCli(detectActiveTools([shell, node, codex], toolProviders, options())), undefined, 'idle and unfocused: dropped');
  const focus = processTreePids(48352, [shell, node, codex]);
  assert.equal(codexCli(detectActiveTools([shell, node, codex], toolProviders, options({ focusedPids: focus })))?.processInfo.pid, 50644);

  // A busy background instance of the same CLI never takes over the focused one.
  t.mock.timers.tick(10_000);
  const working = { ...busy, cpuMs: 5_000 };
  assert.equal(codexCli(detectActiveTools([shell, node, codex, working], toolProviders, options({ focusedPids: focus })))?.processInfo.pid, 50644);
  // Losing focus drops the idle one again; the busy one remains.
  assert.equal(codexCli(detectActiveTools([shell, node, codex, { ...working, cpuMs: 9_000 }], toolProviders, options()))?.processInfo.pid, 60000);
});

test('the focused process tree rejects reused parent pids and unknown roots', () => {
  const { processTreePids } = require('../dist/core/detection/active-tools');
  const shell = { pid: 100, ppid: 1, line: 'pwsh.exe', createdAtMs: 2_000 };
  const own = { pid: 101, ppid: 100, line: 'codex.exe', createdAtMs: 3_000 };
  // Older than pid 100's current owner: its real parent exited long ago.
  const orphan = { pid: 102, ppid: 100, line: 'codex.exe', createdAtMs: 1_000 };
  const cycleA = { pid: 200, ppid: 201, line: 'a' };
  const cycleB = { pid: 201, ppid: 200, line: 'b' };
  assert.deepEqual([...processTreePids(100, [shell, own, orphan])].sort(), [100, 101]);
  assert.deepEqual([...processTreePids(999, [shell, own])], []);
  assert.deepEqual([...processTreePids(200, [cycleA, cycleB])].sort(), [200, 201]);
  assert.deepEqual([...processTreePids(null, [shell])], []);
});

test('a headless codex exec rollout is recognised from its session_meta', () => {
  const { readCodexSessionSource } = require('../dist/state-store');
  const rollout = (source) => {
    const file = path.join(root, `rollout-${source}.jsonl`);
    writeJson(file, `${JSON.stringify({ timestamp: '2026-11-03T11:25:42Z', type: 'session_meta', payload: { id: 'x', originator: source === 'exec' ? 'codex_exec' : 'codex_cli_rs', source } })}\n${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } })}\n`);
    return file;
  };
  assert.equal(readCodexSessionSource(rollout('exec')), 'exec');
  // Real session_meta lines hold the whole base instructions (well past 64 KiB).
  const big = path.join(root, 'rollout-big.jsonl');
  writeJson(big, `${JSON.stringify({ type: 'session_meta', payload: { base_instructions: { text: 'x'.repeat(700_000) }, source: 'exec' } })}\n{}\n`);
  assert.equal(readCodexSessionSource(big), 'exec');
  assert.equal(readCodexSessionSource(rollout('cli')), 'cli');
  assert.equal(readCodexSessionSource(path.join(root, 'missing.jsonl')), null);
  assert.equal(readCodexSessionSource(null), null);
});

test('codex-hook records an interactive session but never a headless exec run', async (t) => {
  const { createTestEnvironment, runCli } = require('./helpers');
  const { env, stateFile } = createTestEnvironment(t);
  const fire = (id, source) => {
    const transcript = path.join(root, `hook-${id}.jsonl`);
    writeJson(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id, source } })}\n`);
    return runCli(['codex-hook', '--event', 'UserPromptSubmit'], env, 15000, JSON.stringify({
      hook_event_name: 'UserPromptSubmit', session_id: id, cwd: root, transcript_path: transcript, model: 'gpt-6.1-sol', prompt: 'p'
    }));
  };
  await fire('exec-run', 'exec');
  await fire('tui-run', 'cli');
  const sessions = JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions;
  assert.equal(Boolean(sessions['exec-run']), false);
  assert.equal(sessions['tui-run']?.model, 'gpt-6.1-sol');
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
