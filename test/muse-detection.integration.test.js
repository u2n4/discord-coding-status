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
  readMuseModelFromFile,
  extractMuseExecSessionId,
  findMuseExecSessionFiles,
  readMuseExecModelForProcess
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

const EXEC_UUID = 'd2aca6d9-1154-4e8d-97ad-77b53b120aba';
const EXEC_UUID_OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function execRouteFacts(sessionId, pid, recordedAtMicros, sequence) {
  return {
    schema_version: 1,
    id: `test-route-${sequence}`,
    stream: { kind: 'session', id: sessionId },
    sequence,
    recorded_at: recordedAtMicros,
    record_type: 'event',
    payload_type: 'runtime.session.route_facts',
    payload: { kind: 'route_facts', record: { pid } }
  };
}

function execModelRecord(sessionId, modelId, recordedAtMicros, sequence) {
  return {
    schema_version: 1,
    id: `test-model-${sequence}`,
    stream: { kind: 'session', id: sessionId },
    sequence,
    recorded_at: recordedAtMicros,
    record_type: 'event',
    payload_type: 'run.model.configured',
    payload: { kind: 'run_model', record: { model_id: modelId } }
  };
}

function execEndRecord(sessionId, recordedAtMicros, sequence) {
  return {
    schema_version: 1,
    id: `test-end-${sequence}`,
    stream: { kind: 'session', id: sessionId },
    sequence,
    recorded_at: recordedAtMicros,
    record_type: 'event',
    payload_type: 'session.end',
    payload: { kind: 'session_end', record: { session_id: sessionId } }
  };
}

function museExecProcess(pid, uuid, createdAtMs, exe) {
  const bin = exe || '/usr/local/bin/muse';
  const cmd = `${bin} exec --session-id ${uuid} --model muse-spark-1.3 "do work"`;
  return { pid, line: cmd, raw: cmd, executablePath: bin, commandLine: cmd, createdAtMs };
}

function withMuseXdg(t) {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-exec-'));
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
  return path.join(xdg, 'muse', 'sessions');
}

test('Muse exec parser accepts only official headless exec with one explicit UUID', () => {
  const winExe = 'C:\\Users\\aliha\\AppData\\Local\\Programs\\muse\\muse-bin-1.4.13-R6996.1.exe';
  const win = {
    line: `"${winExe}" exec --session-id ${EXEC_UUID} --model muse-spark-1.3 --contributor-mode on`,
    executablePath: winExe,
    commandLine: `"${winExe}" exec --session-id ${EXEC_UUID} --model muse-spark-1.3 --contributor-mode on`
  };
  assert.equal(extractMuseExecSessionId(win), EXEC_UUID);
  assert.equal(extractMuseExecSessionId(`/usr/local/bin/muse exec --session-id ${EXEC_UUID}`), EXEC_UUID);
  assert.equal(extractMuseExecSessionId(`muse exec --session-id=${EXEC_UUID}`), EXEC_UUID);
  assert.equal(extractMuseExecSessionId(`muse exec --session-id ${EXEC_UUID.toUpperCase()}`), EXEC_UUID);
  assert.equal(
    extractMuseExecSessionId(`muse exec --session-id ${EXEC_UUID} -- "--session-id ${EXEC_UUID_OTHER}"`),
    EXEC_UUID,
    'prompt text after -- is not a session flag'
  );
});

test('Muse exec parser rejects wrappers, ambiguity, resume, and traversal', () => {
  const cases = [
    'muse',
    '/usr/local/bin/muse',
    'muse exec "fix the test"',
    'muse exec --model muse-spark-1.3',
    'muse --help',
    'muse agent --session-id ' + EXEC_UUID,
    'cmd /c muse exec --session-id ' + EXEC_UUID,
    'echo muse exec --session-id ' + EXEC_UUID,
    'echo "muse exec --session-id ' + EXEC_UUID + '"',
    'powershell -c "muse exec --session-id ' + EXEC_UUID + '"',
    `muse exec --session-id ${EXEC_UUID} --session-id ${EXEC_UUID_OTHER}`,
    `muse exec --session-id ${EXEC_UUID} --session-id ${EXEC_UUID}`,
    'muse exec --session-id',
    'muse exec --session-id --model x',
    'muse exec --session-id not-a-uuid-name',
    'muse exec --session-id ../../etc/passwd',
    'muse exec --session-id ..\\..\\windows',
    `muse exec --session-id ${EXEC_UUID} --resume ${EXEC_UUID_OTHER}`,
    `muse exec --resume ${EXEC_UUID}`,
    'muse --resume ' + EXEC_UUID,
    `muse exec --session_id ${EXEC_UUID}`,
    `muse exec --session ${EXEC_UUID}`,
    `C:\\Tools\\amuse.exe exec --session-id ${EXEC_UUID}`
  ];
  for (const cmd of cases) {
    assert.equal(extractMuseExecSessionId(cmd), null, cmd);
  }
  assert.equal(extractMuseExecSessionId({
    line: `muse exec --session-id ${EXEC_UUID}`,
    executablePath: 'C:\\Windows\\System32\\cmd.exe',
    commandLine: `muse exec --session-id ${EXEC_UUID}`
  }), null, 'cmd wrapper executablePath rejects');
  assert.equal(extractMuseExecSessionId(''), null);
});

test('Muse exec file resolver targets only the UUID root session log', (t) => {
  const sessionsRoot = withMuseXdg(t);
  const file = writeMuseSession(sessionsRoot, ['2026', '10', '27'], EXEC_UUID, [
    execModelRecord(EXEC_UUID, 'muse-spark-1.3', Date.now() * 1000, 1)
  ]);
  assert.deepEqual(findMuseExecSessionFiles(EXEC_UUID), [file]);
  assert.deepEqual(findMuseExecSessionFiles(EXEC_UUID_OTHER), []);
  assert.deepEqual(findMuseExecSessionFiles('not-a-uuid'), []);
  assert.deepEqual(findMuseExecSessionFiles('../../etc'), []);
  const subDir = path.join(sessionsRoot, '2026', '10', '27', EXEC_UUID, 'subagent', EXEC_UUID_OTHER);
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'session.jsonl'), JSON.stringify(
    execModelRecord(EXEC_UUID_OTHER, 'muse-spark-9.9', Date.now() * 1000, 1)
  ) + '\n');
  assert.deepEqual(findMuseExecSessionFiles(EXEC_UUID_OTHER), [], 'child session logs are never substituted');
});

test('Muse exec model reader requires open segment, PID, and freshness guards', (t) => {
  const sessionsRoot = withMuseXdg(t);
  const startedAt = Date.now();
  const micros = (ms) => ms * 1000;
  const goodFile = writeMuseSession(sessionsRoot, ['2026', '10', '27'], EXEC_UUID, [
    execRouteFacts(EXEC_UUID, 42712, micros(startedAt + 10), 4),
    execModelRecord(EXEC_UUID, 'muse-spark-1.3', micros(startedAt + 1000), 28)
  ]);
  const good = readMuseExecModelForProcess(museExecProcess(42712, EXEC_UUID, startedAt));
  assert.ok(good);
  assert.equal(good.model, 'muse-spark-1.3');
  assert.equal(good.sessionFile, goodFile);

  const endedFile = writeMuseSession(sessionsRoot, ['2026', '10', '27'], EXEC_UUID_OTHER, [
    execRouteFacts(EXEC_UUID_OTHER, 42713, micros(startedAt + 10), 4),
    execModelRecord(EXEC_UUID_OTHER, 'muse-spark-1.3', micros(startedAt + 1000), 28),
    execEndRecord(EXEC_UUID_OTHER, micros(startedAt + 2000), 68)
  ]);
  assert.ok(endedFile);
  assert.equal(
    readMuseExecModelForProcess(museExecProcess(42713, EXEC_UUID_OTHER, startedAt + 3000)),
    null,
    'an ended prior run must not leak its model to a reused UUID'
  );
  assert.equal(
    readMuseExecModelForProcess({ ...museExecProcess(99999, EXEC_UUID, startedAt), pid: 99999 }),
    null,
    'route_facts PID must match the live process'
  );
  assert.equal(
    readMuseExecModelForProcess({ ...museExecProcess(42712, EXEC_UUID, undefined), createdAtMs: undefined }),
    null,
    'missing process start time fails closed'
  );
  const staleUuid = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  writeMuseSession(sessionsRoot, ['2026', '10', '27'], staleUuid, [
    execRouteFacts(staleUuid, 42714, micros(startedAt - 60000), 4),
    execModelRecord(staleUuid, 'muse-spark-1.0', micros(startedAt - 50000), 28)
  ]);
  assert.equal(
    readMuseExecModelForProcess(museExecProcess(42714, staleUuid, startedAt)),
    null,
    'a model older than the process start is a prior run, not current'
  );
  const aliasUuid = 'cccccccc-dddd-4eee-8fff-000000000000';
  writeMuseSession(sessionsRoot, ['2026', '10', '27'], aliasUuid, [
    execRouteFacts(aliasUuid, 42715, micros(startedAt + 10), 4),
    execModelRecord(aliasUuid, 'same-as-main', micros(startedAt + 1000), 28)
  ]);
  assert.equal(readMuseExecModelForProcess(museExecProcess(42715, aliasUuid, startedAt)), null, 'alias is not a model');
  const bare = { pid: 42716, line: '/usr/local/bin/muse', raw: '/usr/local/bin/muse', executablePath: '/usr/local/bin/muse', commandLine: 'muse', createdAtMs: startedAt };
  assert.equal(readMuseExecModelForProcess(bare), null, 'bare TUI has no UUID binding');
});

test('Muse exec model reader accepts a reused UUID only after its new run configures', (t) => {
  const sessionsRoot = withMuseXdg(t);
  const run1Start = Date.now() - 120000;
  const run2Start = Date.now();
  const micros = (ms) => ms * 1000;
  writeMuseSession(sessionsRoot, ['2026', '10', '27'], EXEC_UUID, [
    execRouteFacts(EXEC_UUID, 11111, micros(run1Start + 10), 4),
    execModelRecord(EXEC_UUID, 'muse-spark-1.0', micros(run1Start + 1000), 28),
    execEndRecord(EXEC_UUID, micros(run1Start + 2000), 68),
    execRouteFacts(EXEC_UUID, 22222, micros(run2Start + 10), 104),
    execModelRecord(EXEC_UUID, 'muse-spark-1.3', micros(run2Start + 1000), 128)
  ]);
  const current = readMuseExecModelForProcess(museExecProcess(22222, EXEC_UUID, run2Start));
  assert.ok(current);
  assert.equal(current.model, 'muse-spark-1.3', 'new run model wins, old run model never leaks');
  assert.equal(readMuseExecModelForProcess(museExecProcess(11111, EXEC_UUID, run1Start)), null, 'prior PID no longer current');
});

test('Muse exec binding fails closed on stale, foreign, NaN, and old-route evidence', (t) => {
  const sessionsRoot = withMuseXdg(t);
  const startedAt = Date.now();
  const micros = (ms) => ms * 1000;
  const POS_UUID = '11111111-1111-4111-8111-111111111111';
  const STALE_UUID = '22222222-2222-4222-8222-222222222222';
  const FILE_UUID = '33333333-3333-4333-8333-333333333333';
  const FOREIGN_STREAM = '44444444-4444-4444-8444-444444444444';
  const NAN_UUID = '55555555-5555-4555-8555-555555555555';
  const OLDROUTE_UUID = '66666666-6666-4666-8666-666666666666';

  writeMuseSession(sessionsRoot, ['2026', '10', '27'], POS_UUID, [
    execRouteFacts(POS_UUID, 42712, micros(startedAt + 10), 4),
    execModelRecord(POS_UUID, 'muse-spark-1.3', micros(startedAt + 1000), 28)
  ]);
  const positive = readMuseExecModelForProcess(museExecProcess(42712, POS_UUID, startedAt));
  assert.ok(positive, 'valid current control still binds');
  assert.equal(positive.model, 'muse-spark-1.3');

  writeMuseSession(sessionsRoot, ['2026', '10', '27'], STALE_UUID, [
    execRouteFacts(STALE_UUID, 42720, micros(startedAt - 1000), 4),
    execModelRecord(STALE_UUID, 'muse-spark-1.0', micros(startedAt - 1000), 28)
  ]);
  assert.equal(
    readMuseExecModelForProcess(museExecProcess(42720, STALE_UUID, startedAt)),
    null,
    'same PID 1s before process start is stale, not current (no 2s tolerance)'
  );

  writeMuseSession(sessionsRoot, ['2026', '10', '27'], FILE_UUID, [
    execRouteFacts(FOREIGN_STREAM, 42721, micros(startedAt + 10), 4),
    execModelRecord(FILE_UUID, 'muse-spark-1.3', micros(startedAt + 1000), 28)
  ]);
  assert.equal(
    readMuseExecModelForProcess(museExecProcess(42721, FILE_UUID, startedAt)),
    null,
    'foreign-stream route_facts with the same PID must not bind'
  );

  writeMuseSession(sessionsRoot, ['2026', '10', '27'], NAN_UUID, [
    execRouteFacts(NAN_UUID, 42722, micros(startedAt + 10), 4),
    execModelRecord(NAN_UUID, 'muse-spark-1.3', micros(startedAt + 1000), 28)
  ]);
  assert.equal(
    readMuseExecModelForProcess(museExecProcess(42722, NAN_UUID, NaN)),
    null,
    'NaN process start fails closed'
  );
  assert.equal(
    readMuseExecModelForProcess(museExecProcess(42722, NAN_UUID, Infinity)),
    null,
    'non-finite process start fails closed'
  );
  for (const badPid of [0, -1, 1.5, NaN]) {
    assert.equal(
      readMuseExecModelForProcess(museExecProcess(badPid, NAN_UUID, startedAt)),
      null,
      `PID ${String(badPid)} is not a finite positive integer`
    );
  }

  writeMuseSession(sessionsRoot, ['2026', '10', '27'], OLDROUTE_UUID, [
    execRouteFacts(OLDROUTE_UUID, 42723, micros(startedAt - 60000), 4),
    execModelRecord(OLDROUTE_UUID, 'muse-spark-1.3', micros(startedAt + 1000), 28)
  ]);
  assert.equal(
    readMuseExecModelForProcess(museExecProcess(42723, OLDROUTE_UUID, startedAt)),
    null,
    'old route plus new model without a current route fails closed'
  );
});

test('Muse exec end handling ignores foreign streams but honors the root close', (t) => {
  const sessionsRoot = withMuseXdg(t);
  const startedAt = Date.now();
  const micros = (ms) => ms * 1000;
  const FOREIGN_END_UUID = '77777777-7777-4777-8777-777777777777';
  const FOREIGN_STREAM = '44444444-4444-4444-8444-444444444444';
  const ROOT_END_UUID = '88888888-8888-4888-8888-888888888888';

  writeMuseSession(sessionsRoot, ['2026', '10', '27'], FOREIGN_END_UUID, [
    execRouteFacts(FOREIGN_END_UUID, 42724, micros(startedAt + 10), 4),
    execModelRecord(FOREIGN_END_UUID, 'muse-spark-1.3', micros(startedAt + 1000), 28),
    execEndRecord(FOREIGN_STREAM, micros(startedAt + 2000), 68)
  ]);
  const foreignEnd = readMuseExecModelForProcess(museExecProcess(42724, FOREIGN_END_UUID, startedAt));
  assert.ok(foreignEnd, 'foreign-stream end must not close the current root segment');
  assert.equal(foreignEnd.model, 'muse-spark-1.3');

  writeMuseSession(sessionsRoot, ['2026', '10', '27'], ROOT_END_UUID, [
    execRouteFacts(ROOT_END_UUID, 42725, micros(startedAt + 10), 4),
    execModelRecord(ROOT_END_UUID, 'muse-spark-1.3', micros(startedAt + 1000), 28),
    execEndRecord(ROOT_END_UUID, micros(startedAt + 2000), 68)
  ]);
  assert.equal(
    readMuseExecModelForProcess(museExecProcess(42725, ROOT_END_UUID, startedAt)),
    null,
    'root end after the model closes the segment'
  );
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
