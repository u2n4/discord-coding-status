'use strict';

// Setup lifecycle regression: a failed `setup` must never leave the runtime
// stopped, and the elevated schtasks retry must be time-bounded.
//
// Both tests run the real `setup` command with ALL schtasks/powershell calls
// intercepted by test/fixtures/mock-schtasks-lifecycle.cjs, so they perform
// zero real scheduled-task writes. The mock forces /Create to fail with
// "Access is denied." (the 10:44 incident shape) and the RunAs retry to fail
// with ETIMEDOUT (what the elevation bound produces when no one answers UAC).
//
// DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART is deliberately set to '0' here:
// with the skip on, the restart-after-failure path is bypassed and there is
// nothing to observe. This is safe ONLY because the mock neutralizes the
// pre-copy daemon kill as well; the DCS-Test-* task-name assertion below
// guards the isolation assumption.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTestEnvironment, runCli } = require('./helpers');

const FIXTURE = path.join(__dirname, 'fixtures', 'mock-schtasks-lifecycle.cjs');
const WIN_ONLY = { skip: process.platform !== 'win32' };

function mockEnv(t) {
  const { directory, env } = createTestEnvironment(t, {});
  assert.match(env.DISCORD_CODING_STATUS_TASK_NAME, /^DCS-Test-/);
  const logFile = path.join(directory, 'schtasks-mock.jsonl');
  env.MOCK_SCHTASKS_LOG = logFile;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS} --require=${FIXTURE}`;
  // Arm the real restart path; the mock keeps every task/process call safe.
  env.DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART = '0';
  return { directory, env, logFile };
}

function readMockCalls(logFile) {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs.readFileSync(logFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function schtasksVerbs(calls) {
  return calls
    .filter((call) => call.file === 'schtasks' || call.file === 'schtasks.exe')
    .map((call) => call.args.find((arg) => arg.startsWith('/')) || '');
}

test('failed setup reports the UAC timeout and restarts the previous daemon', WIN_ONLY, async (t) => {
  const { env, logFile } = mockEnv(t);

  await assert.rejects(
    () => runCli(['setup', '--no-codex-hooks', '--no-claude-hooks', '--no-grok-hooks'], env, 60000),
    /timed out waiting for the UAC prompt/
  );

  const calls = readMockCalls(logFile);
  const runAsCalls = calls.filter((call) => call.args.join(' ').includes('RunAs'));
  assert.equal(runAsCalls.length, 1, `expected one elevation retry, got ${runAsCalls.length}`);
  assert.equal(typeof runAsCalls[0].timeout, 'number');
  assert.ok(runAsCalls[0].timeout > 0, 'elevation retry must carry a timeout bound');

  const verbs = schtasksVerbs(calls);
  const createIndex = verbs.indexOf('/Create');
  assert.ok(createIndex >= 0, 'expected a schtasks /Create attempt');
  // Restart-after-failure: probe the surviving task, then /End + /Run it.
  assert.deepEqual(verbs.slice(createIndex), ['/Create', '/Query', '/End', '/Run']);

  const runCall = calls.find((call) => call.args[0] === '/Run');
  assert.ok(runCall, 'expected a schtasks /Run restart after setup failed');
  assert.ok(
    runCall.args.includes(env.DISCORD_CODING_STATUS_TASK_NAME),
    'restart must target the managed task'
  );
});

test('failed setup with --no-start does not restart the daemon', WIN_ONLY, async (t) => {
  const { env, logFile } = mockEnv(t);

  await assert.rejects(
    () => runCli(['setup', '--no-start', '--no-codex-hooks', '--no-claude-hooks', '--no-grok-hooks'], env, 60000)
  );

  const calls = readMockCalls(logFile);
  const verbs = schtasksVerbs(calls);
  const createIndex = verbs.indexOf('/Create');
  assert.ok(createIndex >= 0, 'expected a schtasks /Create attempt');
  assert.ok(
    !verbs.slice(createIndex).includes('/Run'),
    `--no-start must suppress the restart, got [${verbs.slice(createIndex).join(', ')}]`
  );
});
