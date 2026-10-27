'use strict';

// Discord application IDs resolve from the environment at import time, so the
// legacy-fallback setup must be assigned before the first require. node --test
// runs each test file in its own process, keeping this override local.
const assert = require('node:assert/strict');
const test = require('node:test');

const LEGACY_FALLBACK_ID = '1111222233334444';
process.env.DISCORD_CLIENT_ID = LEGACY_FALLBACK_ID;
process.env.DISCORD_CODING_STATUS_MUSE_CLIENT_ID = '';
process.env.DISCORD_CODING_STATUS_CODEX_CLIENT_ID = '1517375602662051900';

const { clientIdForTool } = require('../dist/presence');

test('a known tool without its own ID fails closed instead of using the legacy fallback', () => {
  assert.equal(
    clientIdForTool({
      key: 'museCli',
      family: 'muse',
      providerId: 'museCli',
      source: 'process',
      details: 'Using Muse',
      state: 'Muse Code'
    }),
    null,
    'ID-less Muse must never publish under the legacy global ID'
  );
});

test('a configured tool keeps its own ID when a legacy fallback exists', () => {
  assert.equal(
    clientIdForTool({
      key: 'codexCli',
      family: 'codex',
      providerId: 'codexCli',
      source: 'process',
      details: 'Using Codex',
      state: 'Codex CLI'
    }),
    '1517375602662051900'
  );
});

test('a genuinely unknown legacy tool keeps the fallback ID', () => {
  assert.equal(
    clientIdForTool({
      key: 'state:legacy-unknown',
      family: 'other',
      source: 'hook',
      details: 'Using Sandman',
      state: 'Sandman'
    }),
    LEGACY_FALLBACK_ID
  );
});
