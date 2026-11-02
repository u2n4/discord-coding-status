'use strict';

// Session roots resolve from the environment (CODEX_HOME at import time), so
// the temp overrides must be assigned before the first require. node --test
// runs each test file in its own process, keeping this override local.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-coding-status-attribution-'));
process.env.XDG_DATA_HOME = path.join(scratch, 'xdg');
process.env.CODEX_HOME = path.join(scratch, 'codex-home');
process.env.DISCORD_CODING_STATUS_STATE_MAX_AGE_MS = '900000';

const { enrichToolForPresence } = require('../dist/presence');
const { detectActiveTools } = require('../dist/core/detection/active-tools');
const { toolProviders } = require('../dist/providers/registry');
const { readActiveMuseModel } = require('../dist/providers/muse/model');

function freshScratch(t) {
  resetSessionRoots();
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
}

function museSessionsRoot() {
  return path.join(process.env.XDG_DATA_HOME, 'muse', 'sessions');
}

function codexSessionsRoot() {
  return path.join(process.env.CODEX_HOME, 'sessions');
}

function resetSessionRoots() {
  fs.rmSync(museSessionsRoot(), { recursive: true, force: true });
  fs.rmSync(codexSessionsRoot(), { recursive: true, force: true });
  fs.mkdirSync(museSessionsRoot(), { recursive: true });
  fs.mkdirSync(codexSessionsRoot(), { recursive: true });
}

function writeMuseSession(sessionId, modelIds) {
  const directory = path.join(museSessionsRoot(), '2026', '10', '27', sessionId);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'session.jsonl');
  fs.writeFileSync(
    file,
    modelIds
      .map((modelId) => JSON.stringify({
        payload_type: 'run.model.configured',
        payload: { kind: 'run_model', record: { model_id: modelId } }
      }))
      .join('\n') + '\n'
  );
  return file;
}

function writeRollout(name, model) {
  const file = path.join(codexSessionsRoot(), `rollout-${name}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: 'turn_context', payload: { model } })}\n`
  );
  return file;
}

function processTool(family, key, providerId) {
  return {
    key,
    family,
    providerId,
    source: 'process',
    details: `Using ${family}`,
    state: family
  };
}

test('an unrelated fresh Muse session cannot relabel the active app', async (t) => {
  freshScratch(t);
  writeMuseSession('active-session', ['muse-spark-1.3']);
  writeMuseSession('unrelated-session', ['muse-spark-9.9-unrelated']);

  assert.equal(readActiveMuseModel(Date.now() - 15 * 60_000), null);

  const enriched = await enrichToolForPresence(processTool('muse', 'museCli', 'museCli'));
  assert.equal(enriched.details, '', 'ambiguous models fall back to application name only');
  assert.equal(enriched.state, '');
});

test('an unrelated fresh Codex rollout cannot relabel the desktop app', async (t) => {
  freshScratch(t);
  writeRollout('2026-10-27T01-00-00-aaaa', 'gpt-5.6-sol');
  writeRollout('2026-10-27T02-00-00-bbbb', 'gpt-unrelated-other');

  const enriched = await enrichToolForPresence(processTool('codex', 'codexApp', 'codexApp'));
  assert.equal(enriched.details, '', 'ambiguous rollouts fall back to application name only');
  assert.equal(enriched.state, '');
});

test('agreeing fresh sessions still cannot label the process (consensus is not evidence)', async (t) => {
  freshScratch(t);
  writeMuseSession('session-a', ['muse-spark-1.3']);
  writeMuseSession('session-b', ['muse-spark-1.3']);
  writeRollout('2026-10-27T01-00-00-aaaa', 'gpt-5.6-sol');
  writeRollout('2026-10-27T02-00-00-bbbb', 'gpt-5.6-sol');

  const muse = await enrichToolForPresence(processTool('muse', 'museCli', 'museCli'));
  assert.equal(muse.details, '', 'agreement is not attribution: app-only');

  const codex = await enrichToolForPresence(processTool('codex', 'codexApp', 'codexApp'));
  assert.equal(codex.details, '', 'agreement is not attribution: app-only');
});

test('ONE single fresh Muse file cannot label the process', async (t) => {
  freshScratch(t);
  writeMuseSession('lone-unrelated-session', ['muse-spark-9.9-lone']);

  assert.equal(readActiveMuseModel(Date.now() - 15 * 60_000), null);

  const enriched = await enrichToolForPresence(processTool('muse', 'museCli', 'museCli'));
  assert.equal(enriched.details, '', 'a single unbound file is not attribution');
  assert.equal(enriched.state, '');
});

test('ONE single fresh Codex rollout cannot label the desktop app', async (t) => {
  freshScratch(t);
  writeRollout('2026-10-27T03-00-00-cccc', 'gpt-lone-unrelated');

  const enriched = await enrichToolForPresence(processTool('codex', 'codexApp', 'codexApp'));
  assert.equal(enriched.details, '', 'a single unbound rollout is not attribution');
  assert.equal(enriched.state, '');
});

const EXEC_UUID = 'd2aca6d9-1154-4e8d-97ad-77b53b120aba';

function execProcessInfo(pid, uuid, createdAtMs) {
  const cmd = `/usr/local/bin/muse exec --session-id ${uuid} "do work"`;
  return {
    pid,
    line: cmd,
    raw: cmd,
    executablePath: '/usr/local/bin/muse',
    commandLine: cmd,
    createdAtMs
  };
}

function writeMuseExecSession(sessionId, pid, modelId, startedAtMs, extraRecords) {
  const micros = (ms) => ms * 1000;
  const records = [
    {
      schema_version: 1,
      stream: { kind: 'session', id: sessionId },
      sequence: 4,
      recorded_at: micros(startedAtMs + 10),
      payload_type: 'runtime.session.route_facts',
      payload: { kind: 'route_facts', record: { pid } }
    },
    {
      schema_version: 1,
      stream: { kind: 'session', id: sessionId },
      sequence: 28,
      recorded_at: micros(startedAtMs + 1000),
      payload_type: 'run.model.configured',
      payload: { kind: 'run_model', record: { model_id: modelId } }
    },
    ...(extraRecords || [])
  ];
  const directory = path.join(museSessionsRoot(), '2026', '10', '27', sessionId);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'session.jsonl');
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

function museExecTool(processInfo) {
  return {
    key: 'museCli',
    family: 'muse',
    providerId: 'museCli',
    source: 'process',
    details: 'Using Muse',
    state: 'Muse Code',
    processInfo
  };
}

test('a positively bound exec process shows its exact session model', async (t) => {
  freshScratch(t);
  const startedAt = Date.now();
  writeMuseExecSession(EXEC_UUID, 42712, 'muse-spark-1.3', startedAt);
  writeMuseSession('unrelated-session', ['muse-spark-9.9-unrelated']);

  const enriched = await enrichToolForPresence(museExecTool(execProcessInfo(42712, EXEC_UUID, startedAt)));
  assert.equal(enriched.details, 'Model: Muse Spark 1.3');
  assert.equal(enriched.state, '');
});

test('a bare TUI exec process with no UUID stays app-only', async (t) => {
  freshScratch(t);
  const startedAt = Date.now();
  writeMuseExecSession(EXEC_UUID, 42712, 'muse-spark-1.3', startedAt);

  const bare = {
    pid: 42799,
    line: '/usr/local/bin/muse',
    raw: '/usr/local/bin/muse',
    executablePath: '/usr/local/bin/muse',
    commandLine: '/usr/local/bin/muse',
    createdAtMs: startedAt
  };
  const enriched = await enrichToolForPresence(museExecTool(bare));
  assert.equal(enriched.details, '', 'no UUID means no binding, even with a fresh session file present');
  assert.equal(enriched.state, '');

  const noFlagExec = {
    pid: 42800,
    line: '/usr/local/bin/muse exec "do work"',
    raw: '/usr/local/bin/muse exec "do work"',
    executablePath: '/usr/local/bin/muse',
    commandLine: '/usr/local/bin/muse exec "do work"',
    createdAtMs: startedAt
  };
  const enrichedExec = await enrichToolForPresence(museExecTool(noFlagExec));
  assert.equal(enrichedExec.details, '', 'exec without --session-id stays app-only');
});

test('an exec process whose session ended stays app-only', async (t) => {
  freshScratch(t);
  const startedAt = Date.now();
  writeMuseExecSession(EXEC_UUID, 42712, 'muse-spark-1.3', startedAt - 60000, [
    {
      schema_version: 1,
      stream: { kind: 'session', id: EXEC_UUID },
      sequence: 68,
      recorded_at: (startedAt - 59000) * 1000,
      payload_type: 'session.end',
      payload: { kind: 'session_end', record: { session_id: EXEC_UUID } }
    }
  ]);

  const enriched = await enrichToolForPresence(museExecTool(execProcessInfo(42712, EXEC_UUID, startedAt)));
  assert.equal(enriched.details, '', 'ended session model must not leak to a live reused UUID');
  assert.equal(enriched.state, '');
});

test('multiple Muse processes omit the model on ambiguity', async (t) => {
  freshScratch(t);
  const startedAt = Date.now();
  writeMuseExecSession(EXEC_UUID, 42712, 'muse-spark-1.3', startedAt);

  const exec = execProcessInfo(42712, EXEC_UUID, startedAt);
  const bareTui = {
    pid: 42799,
    line: '/usr/local/bin/muse',
    raw: '/usr/local/bin/muse',
    executablePath: '/usr/local/bin/muse',
    commandLine: '/usr/local/bin/muse',
    createdAtMs: startedAt
  };
  const tools = detectActiveTools([exec, bareTui], toolProviders, { idleGraceMs: 5 * 60_000, activeCpuMs: 0 });
  const muse = tools.find((tool) => tool.family === 'muse');
  assert.ok(muse);
  assert.equal(muse.processAmbiguous, true, 'two Muse processes mark the tool ambiguous');

  const enriched = await enrichToolForPresence({ ...museExecTool(exec), processAmbiguous: true });
  assert.equal(enriched.details, '', 'a bound background exec must not label an unknown foreground TUI');
  assert.equal(enriched.state, '');

  const single = detectActiveTools([exec], toolProviders, { idleGraceMs: 5 * 60_000, activeCpuMs: 0 });
  assert.equal(single.find((tool) => tool.family === 'muse').processAmbiguous, undefined);
});

test('an explicit hook model still wins over ambiguous session files', async (t) => {
  freshScratch(t);
  writeMuseSession('session-a', ['muse-model-a']);
  writeMuseSession('session-b', ['muse-model-b']);
  writeRollout('2026-10-27T01-00-00-aaaa', 'gpt-model-a');
  writeRollout('2026-10-27T02-00-00-bbbb', 'gpt-model-b');

  const codex = await enrichToolForPresence({
    ...processTool('codex', 'state:codex-explicit', 'codexCli'),
    source: 'hook',
    sessionId: 'codex-explicit',
    model: 'gpt-hook-explicit'
  });
  assert.equal(codex.details, 'Model: gpt-hook-explicit');

  const muse = await enrichToolForPresence({
    ...processTool('muse', 'state:muse-explicit', 'museCli'),
    source: 'hook',
    sessionId: 'muse-explicit',
    model: 'muse-hook-explicit'
  });
  assert.equal(muse.details, 'Model: muse-hook-explicit');
});
