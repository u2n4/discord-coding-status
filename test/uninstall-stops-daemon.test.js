'use strict';

// `uninstall` removes the startup entry and the copied runtime. The daemon it
// started is a detached process, so unless uninstall stops it, it keeps
// publishing presence until logoff. The real schtasks /Delete only ever sees
// the helpers' DCS-Test-* task name, which does not exist. Windows only: on
// macOS `launchctl bootout` stops the managed daemon, and the lock stop cannot
// verify a directly spawned process there.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { createTestEnvironment, runCli, startDaemon, waitFor } = require('./helpers');

test('uninstall stops the running daemon before removing its runtime', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const { env, stateFile } = createTestEnvironment(t);
  assert.match(env.DISCORD_CODING_STATUS_TASK_NAME, /^DCS-Test-/);
  const lockFile = `${stateFile}.daemon.lock`;
  const daemon = startDaemon(t, env);

  await waitFor(() => fs.existsSync(lockFile), 'daemon lock file');
  assert.equal(daemon.child.exitCode, null, 'daemon is running before uninstall');

  const result = await runCli(['uninstall'], env);
  assert.match(result.stdout, /startup entry removed/);

  await waitFor(
    () => daemon.child.exitCode !== null || daemon.child.signalCode !== null,
    'daemon exit after uninstall'
  );
});
