'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const live = require('../dist/providers/antigravity/live-labels');
const antigravity = require('../dist/providers/antigravity/model');
const { displayModelLabel } = require('../dist/providers/model-label');

// Shape copied from a real GetCascadeModelConfigData answer (2026-11-03).
const CONFIGS = {
  clientModelConfigs: [
    { label: 'Gemini 4 Argon (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M418' } },
    { label: 'Gemini 3.8 Flash (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M319' } },
    { label: 'Claude Sonnet 5.5 (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M405' } },
    { label: 'GPT-OSS 120B (Medium)', modelOrAlias: { model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM' } },
    { label: 'bad "quote"', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M1' } },
    { label: 'No placeholder', modelOrAlias: {} }
  ]
};

function withTempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-ag-live-'));
  const previous = {
    cache: process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_LABEL_CACHE,
    home: process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOME
  };
  process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_LABEL_CACHE = path.join(dir, 'cache', 'antigravity-models.json');
  process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOME = path.join(dir, 'ag');
  fs.mkdirSync(process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOME, { recursive: true });
  live.resetAntigravityLiveLabelsForTests();
  antigravity.resetAntigravityModelLearning();
  t.after(() => {
    for (const [key, name] of [['cache', 'DISCORD_CODING_STATUS_ANTIGRAVITY_LABEL_CACHE'], ['home', 'DISCORD_CODING_STATUS_ANTIGRAVITY_HOME']]) {
      if (previous[key] === undefined) delete process.env[name];
      else process.env[name] = previous[key];
    }
    live.resetAntigravityLiveLabelsForTests();
    antigravity.resetAntigravityModelLearning();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('picker configs parse into placeholder -> label, rejecting malformed entries', () => {
  const labels = live.parseCascadeModelConfigs(CONFIGS);
  assert.deepEqual([...labels], [
    ['MODEL_PLACEHOLDER_M418', 'Gemini 4 Argon (Medium)'],
    ['MODEL_PLACEHOLDER_M319', 'Gemini 3.8 Flash (Medium)'],
    ['MODEL_PLACEHOLDER_M405', 'Claude Sonnet 5.5 (High)'],
    ['MODEL_OPENAI_GPT_OSS_120B_MEDIUM', 'GPT-OSS 120B (Medium)']
  ]);
  assert.equal(live.parseCascadeModelConfigs(null).size, 0);
  assert.equal(live.parseCascadeModelConfigs({ clientModelConfigs: 'x' }).size, 0);
});

test('language server log yields the plain HTTP port of the latest start', () => {
  const log = [
    'I1102 server.go:1798] Starting language server process with pid 100',
    'I1102 server.go:765] Language server listening on random port at 40001 for HTTP',
    'I1103 server.go:1798] Starting language server process with pid 49612',
    'I1103 server.go:757] Language server listening on random port at 51446 for HTTPS (gRPC)',
    'I1103 server.go:765] Language server listening on random port at 51447 for HTTP'
  ].join('\r\n');
  assert.deepEqual(live.parseLanguageServerLog(log), { pid: 49612, httpPort: 51447 });
  // A restart whose HTTP line has not been written yet must not reuse the old port.
  assert.equal(live.parseLanguageServerLog(`${log}\nStarting language server process with pid 7`), null);
  assert.equal(live.parseLanguageServerLog(''), null);
});

test('csrf token is taken only from the pid-matched Antigravity language server that owns the port', () => {
  const record = {
    Name: 'language_server.exe',
    ProcessId: 49612,
    ExecutablePath: 'C:\\Users\\a\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe',
    CommandLine: 'language_server.exe --standalone --csrf_token 0123abcd-4567-89ef-0123-456789abcdef --app_data_dir antigravity'
  };
  const endpoint = { pid: 49612, httpPort: 51447 };
  const lookup = (overrides = {}) => ({ Process: record, PortOwners: [49612], ...overrides });
  assert.equal(live.parseLanguageServerLookup(lookup(), endpoint), '0123abcd-4567-89ef-0123-456789abcdef');
  // ConvertTo-Json writes a one-element array as a bare number.
  assert.equal(live.parseLanguageServerLookup(lookup({ PortOwners: 49612 }), endpoint), '0123abcd-4567-89ef-0123-456789abcdef');
  assert.equal(live.parseLanguageServerLookup(lookup(), { ...endpoint, pid: 1 }), null);
  assert.equal(live.parseLanguageServerLookup(lookup({ Process: { ...record, Name: 'node.exe' } }), endpoint), null);
  assert.equal(live.parseLanguageServerLookup(lookup({ Process: { ...record, ExecutablePath: 'C:\\other\\language_server.exe' } }), endpoint), null);
  // A stale log port now held by another listener never receives the token.
  assert.equal(live.parseLanguageServerLookup(lookup({ PortOwners: [777] }), endpoint), null);
  assert.equal(live.parseLanguageServerLookup(lookup({ PortOwners: [] }), endpoint), null);
  assert.equal(live.parseLanguageServerLookup(lookup({ PortOwners: null }), endpoint), null);
  assert.equal(live.parseLanguageServerLookup(null, endpoint), null);
});

test('labels are fetched from the language server with its csrf header', async (t) => {
  let seen = null;
  const server = http.createServer((request, response) => {
    seen = { url: request.url, csrf: request.headers['x-codeium-csrf-token'] };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(CONFIGS));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const labels = await live.fetchAntigravityModelLabels({ httpPort: server.address().port, csrfToken: 'token-123456' });
  assert.equal(seen.url, '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData');
  assert.equal(seen.csrf, 'token-123456');
  assert.equal(labels.get('MODEL_PLACEHOLDER_M319'), 'Gemini 3.8 Flash (Medium)');
});

test('a rejected request fails instead of returning an empty list', async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 401;
    response.end('unauthorized');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(live.fetchAntigravityModelLabels({ httpPort: server.address().port, csrfToken: 'x' }), /401/);
});

test('a trickling answer is cut off by the hard deadline', async (t) => {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const timer = setInterval(() => response.write(' '), 200);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const started = Date.now();
  await assert.rejects(live.fetchAntigravityModelLabels({ httpPort: server.address().port, csrfToken: 'x' }), /deadline/);
  assert.ok(Date.now() - started < 4_000, 'deadline must not stretch with each chunk');
});

test('a placeholder unknown to records resolves from the stored picker list and shows without effort', (t) => {
  withTempEnv(t);
  // M999 stands for a model added after this build: no seed, no record.
  const stateFile = antigravity.getAntigravityStateFile();
  fs.writeFileSync(stateFile, 'last_selected_agent_model:  MODEL_PLACEHOLDER_M999\n');
  assert.equal(antigravity.readActiveAntigravityModel(), null);

  const cacheFile = live.getAntigravityLabelCacheFile();
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    fetchedAt: Date.now(),
    labels: { MODEL_PLACEHOLDER_M999: 'Gemini 5 Nova (High)', MODEL_PLACEHOLDER_M402: 'Claude Opus 5.5 (High)' }
  }));
  const model = antigravity.readActiveAntigravityModel()?.model;
  assert.equal(model, 'Gemini 5 Nova (High)');
  assert.equal(displayModelLabel('antigravity', model), 'Gemini 5 Nova');
  // The stored label outranks the seed id for a known placeholder too.
  assert.equal(antigravity.resolveAntigravityPlaceholder('MODEL_PLACEHOLDER_M402'), 'Claude Opus 5.5 (High)');
});

test('a torn label cache is ignored and the seed still resolves', (t) => {
  withTempEnv(t);
  const cacheFile = live.getAntigravityLabelCacheFile();
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, '{"fetchedAt": 1, "labels": {');
  assert.equal(live.readAntigravityLiveLabel('MODEL_PLACEHOLDER_M402'), null);
  assert.equal(antigravity.resolveAntigravityPlaceholder('MODEL_PLACEHOLDER_M402'), 'claude-opus-5-5-high');
});

test('a reset drops a refresh still running from before it', async (t) => {
  const dir = withTempEnv(t);
  // A log pointing at a pid that never answers keeps the refresh busy in the
  // lookup; the reset must clear the guard so the next caller is not blocked.
  const userData = path.join(dir, 'user-data');
  fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'logs', 'language_server.log'), [
    'Starting language server process with pid 4000000',
    'Language server listening on random port at 1 for HTTP'
  ].join('\n'));
  const previous = process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_USER_DATA;
  process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_USER_DATA = userData;
  t.after(() => {
    if (previous === undefined) delete process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_USER_DATA;
    else process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_USER_DATA = previous;
  });
  let calls = 0;
  live.onAntigravityLiveLabelsChanged(() => { calls += 1; });
  live.ensureAntigravityLiveLabels('MODEL_PLACEHOLDER_M999');
  live.resetAntigravityLiveLabelsForTests();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(live.getAntigravityLabelCacheFile()), false);
});

test('the newest start block wins wherever it sits in a large appended log', (t) => {
  const dir = withTempEnv(t);
  const userData = path.join(dir, 'user-data');
  fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
  const previous = process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_USER_DATA;
  process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_USER_DATA = userData;
  t.after(() => {
    if (previous === undefined) delete process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_USER_DATA;
    else process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_USER_DATA = previous;
  });
  const logFile = path.join(userData, 'logs', 'language_server.log');
  const filler = (bytes) => `${'I1103 noise line\n'.repeat(Math.ceil(bytes / 17))}`;
  const block = (pid, port) => `Starting language server process with pid ${pid}\nLanguage server listening on random port at ${port + 1} for HTTPS (gRPC)\nLanguage server listening on random port at ${port} for HTTP\n`;
  // Old start at the head, newest start ~3 MB in, then 3 MB of output after it.
  fs.writeFileSync(logFile, block(100, 40000) + filler(3_000_000) + block(200, 50000) + filler(3_000_000));
  assert.deepEqual(live.readLanguageServerEndpoint(), { pid: 200, httpPort: 50000 });
  // A start line split across the 256 KiB chunk edge is still found, and its
  // port lines in the later chunk are kept.
  for (const offset of [5, 30, 60]) {
    const head = filler(1_000_000);
    const tailLength = 256 * 1024;
    const body = block(300 + offset, 51000);
    const pad = 'x'.repeat(Math.max(0, tailLength - (body.length - offset)));
    fs.writeFileSync(logFile, head + body + pad);
    assert.deepEqual(live.readLanguageServerEndpoint(), { pid: 300 + offset, httpPort: 51000 }, `offset ${offset}`);
  }
  fs.writeFileSync(logFile, filler(600_000));
  assert.equal(live.readLanguageServerEndpoint(), null);
});
