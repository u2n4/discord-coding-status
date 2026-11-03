'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDirectory = path.join(__dirname, '..', 'test');
const testFiles = fs
  .readdirSync(testDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => path.join(testDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No test files found in ${testDirectory}`);
}

// The daemon's stored Antigravity picker list would otherwise label the
// placeholders that tests expect to resolve from the seed, and a running
// Antigravity would otherwise be queried from tests.
const labelCacheDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dcs-test-labels-'));

const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...testFiles],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      DISCORD_CODING_STATUS_ANTIGRAVITY_LABEL_CACHE: path.join(labelCacheDir, 'antigravity-models.json'),
      // No language_server.log here, so no test reaches the real server.
      DISCORD_CODING_STATUS_ANTIGRAVITY_USER_DATA: path.join(labelCacheDir, 'antigravity-user-data'),
      // The machine's own OpenCode/Cursor picks and Muse sessions must not
      // label the processes tests fabricate; tests that need them set their own.
      DISCORD_CODING_STATUS_OPENCODE_STATE: path.join(labelCacheDir, 'opencode-model.json'),
      DISCORD_CODING_STATUS_CURSOR_STATE_DB: path.join(labelCacheDir, 'cursor-state.vscdb'),
      XDG_DATA_HOME: path.join(labelCacheDir, 'xdg-data'),
    },
  },
);
fs.rmSync(labelCacheDir, { recursive: true, force: true });

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
