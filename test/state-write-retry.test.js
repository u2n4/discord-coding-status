'use strict';

// The state module resolves STATE_FILE from the environment at import time,
// so the temp override must be assigned before the first require. node --test
// runs each test file in its own process, keeping this override local.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-coding-status-state-retry-'));
const stateFile = path.join(directory, 'states.json');
process.env.DISCORD_CODING_STATUS_STATE_FILE = stateFile;

const { readStateFile, writeStateFile } = require('../dist/state-store');

const realRenameSync = fs.renameSync;

function restoreAfter(t) {
  t.after(() => {
    fs.renameSync = realRenameSync;
    fs.rmSync(directory, { recursive: true, force: true });
  });
}

function lockError(code) {
  const error = new Error(`${code}: operation not permitted, rename`);
  error.code = code;
  return error;
}

function sampleState() {
  return {
    version: 1,
    sessions: {
      sample: {
        tool: 'codex',
        surface: 'cli',
        status: 'running',
        session_id: 'sample',
        cwd: directory,
        updated_at: Date.now()
      }
    }
  };
}

test('writeStateFile retries transient Windows rename locks without losing content', (t) => {
  restoreAfter(t);
  let attempts = 0;
  fs.renameSync = (...args) => {
    attempts += 1;
    if (attempts <= 2) {
      throw lockError(attempts === 1 ? 'EPERM' : 'EACCES');
    }
    return realRenameSync(...args);
  };

  const state = sampleState();
  writeStateFile(state);

  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), state);
  assert.deepEqual(readStateFile(), state);
});

test('writeStateFile still throws after persistent rename failures and cleans the temp file', (t) => {
  restoreAfter(t);
  let attempts = 0;
  fs.renameSync = () => {
    attempts += 1;
    throw lockError('EPERM');
  };

  assert.throws(() => writeStateFile(sampleState()), /EPERM/);
  assert.equal(attempts, 10);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    [],
    'a failed write must not leave its temp file behind'
  );
});

test('writeStateFile does not retry non-lock failures', (t) => {
  restoreAfter(t);
  let attempts = 0;
  fs.renameSync = () => {
    attempts += 1;
    const error = new Error('boom');
    error.code = 'ENOENT';
    throw error;
  };

  assert.throws(() => writeStateFile(sampleState()), /boom/);
  assert.equal(attempts, 1);
});
