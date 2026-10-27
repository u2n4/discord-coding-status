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
