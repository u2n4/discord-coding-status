'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildPresence,
  enrichToolForPresence,
  selectNewestTool
} = require('../dist/presence');
const {
  familyForForegroundProcess,
  getForegroundPid
} = require('../dist/adapters/system/foreground');
const { toolProviders } = require('../dist/providers/registry');
const {
  createTestEnvironment,
  readRpcEvents,
  runCli,
  startDaemon,
  waitFor
} = require('./helpers');

test('enrich keeps only the Model line and drops effort with it', async () => {
  const enriched = await enrichToolForPresence({
    key: 'state:abc',
    family: 'codex',
    source: 'hook',
    details: 'Using Codex',
    state: 'Codex',
    status: 'thinking',
    activity: 'Cooking tokens',
    model: 'gpt-5.6-sol',
    effort: 'xhigh'
  });

  assert.equal(enriched.details, 'Model: gpt-5.6-sol');
  assert.equal(enriched.state, '');
  assert.doesNotMatch(`${enriched.details} ${enriched.state}`, /xhigh|Cooking|thinking/i);
});

test('enrich without a model yields empty lines (application name only)', async () => {
  const enriched = await enrichToolForPresence({
    key: 'piCli',
    family: 'pi',
    source: 'process',
    details: 'Using Pi',
    state: 'Pi',
    status: 'running'
  });

  assert.equal(enriched.details, '');
  assert.equal(enriched.state, '');
});

test('buildPresence never sets a timestamp and omits empty lines', () => {
  const full = buildPresence({
    key: 'x',
    family: 'codex',
    details: 'Model: gpt-5.6-sol',
    state: ''
  });
  assert.equal(full.details, 'Model: gpt-5.6-sol');
  assert.equal(full.state, undefined);
  assert.equal(full.startTimestamp, undefined);
  assert.equal(full.instance, false);

  const appOnly = buildPresence({ key: 'y', family: 'pi', details: '', state: '' });
  assert.equal(appOnly.details, undefined);
  assert.equal(appOnly.state, undefined);
  assert.equal(appOnly.startTimestamp, undefined);
});

test('the foreground family wins over a more recent hook session', () => {
  const now = Date.now();
  const hookTool = {
    key: 'state:claude',
    family: 'claude',
    source: 'hook',
    details: 'Model: claude-opus-4-6',
    state: '',
    updatedAt: now
  };
  const processTool = {
    key: 'museCli',
    family: 'muse',
    source: 'process',
    details: 'Model: muse-spark-1.3',
    state: '',
    updatedAt: now - 60_000
  };

  assert.equal(selectNewestTool([processTool, hookTool]), hookTool);
  assert.equal(selectNewestTool([processTool, hookTool], 'muse'), processTool);
  assert.equal(selectNewestTool([processTool, hookTool], 'unknown-family'), hookTool);
  assert.equal(selectNewestTool([]), null);
});

function processInfo(pid, line, executablePath, ppid) {
  return { pid, ppid, line, raw: line, executablePath, commandLine: line };
}

test('foreground attribution follows terminal descendants and rejects ambiguity', () => {
  const terminal = processInfo(
    100,
    'C:\\Program Files\\WindowsApps\\terminal.exe',
    'C:\\Program Files\\WindowsApps\\terminal.exe'
  );
  const museChild = processInfo(
    101,
    'C:\\Programs\\muse\\muse-bin-1.4.13.exe',
    'C:\\Programs\\muse\\muse-bin-1.4.13.exe',
    100
  );
  const claudeChild = processInfo(
    102,
    'C:\\bin\\claude.exe',
    'C:\\bin\\claude.exe',
    100
  );
  const notepad = processInfo(
    200,
    'C:\\Windows\\notepad.exe',
    'C:\\Windows\\notepad.exe'
  );

  assert.equal(
    familyForForegroundProcess(100, [terminal, museChild], toolProviders),
    'muse'
  );
  assert.equal(
    familyForForegroundProcess(101, [terminal, museChild], toolProviders),
    'muse'
  );
  assert.equal(
    familyForForegroundProcess(100, [terminal, museChild, claudeChild], toolProviders),
    null,
    'split panes stay ambiguous'
  );
  assert.equal(familyForForegroundProcess(200, [notepad], toolProviders), null);
  assert.equal(familyForForegroundProcess(999, [terminal, museChild], toolProviders), null);
});

test('foreground PID detection fails closed', async () => {
  const pid = await getForegroundPid();
  assert.ok(pid === null || (Number.isInteger(pid) && pid > 0));
});

test('a tool without a Discord application ID yields to a configured tool', async (t) => {
  const { env, rpcLogFile } = createTestEnvironment(t, {
    // Pin Muse ID-less even when the user config later defines one.
    DISCORD_CODING_STATUS_MUSE_CLIENT_ID: ''
  });
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  await runCli([
    'hook', '--tool', 'claude', '--surface', 'cli', '--status', 'running',
    '--session-id', 'configured-tool', '--cwd', process.cwd(), '--model', 'claude-model-1'
  ], env);
  // Newer, but Muse has no Discord application ID in this environment.
  await runCli([
    'hook', '--tool', 'muse', '--surface', 'cli', '--status', 'running',
    '--session-id', 'idless-tool', '--cwd', process.cwd(), '--model', 'muse-model-1'
  ], env);

  const activity = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.clientId === '1521213655092428923'
        && event.activity.details === 'Model: claude-model-1'
    ),
    'the configured tool to stay visible'
  );
  assert.ok(activity);
  assert.doesNotMatch(
    readRpcEvents(rpcLogFile).map((event) => JSON.stringify(event)).join('\n'),
    /muse-model-1/
  );
  assert.equal(daemon.output().stderr, '');
});

test('a second daemon instance exits instead of duplicating presence', async (t) => {
  const { env } = createTestEnvironment(t);
  const first = startDaemon(t, env);

  await waitFor(
    () => first.output().stdout.includes('for hook updates'),
    'the first daemon to hold the lock'
  );

  const second = startDaemon(t, env);
  await waitFor(
    () => second.child.exitCode !== null,
    'the second daemon to exit',
    15000
  );
  assert.equal(second.child.exitCode, 0);
  assert.match(second.output().stdout, /already running/);
});
