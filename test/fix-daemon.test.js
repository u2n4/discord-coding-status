'use strict';

// Daemon lifecycle and robustness fixes: restart ordering, atomic lock with
// stale/foreign PID takeover, Desktop model expiry and CLI-hook isolation,
// helper restart backoff, shared-terminal focus, process-cache retention,
// launcher log rotation, and the adaptive slow census. No test touches the
// real scheduled task, the live daemon, or the user's home/config.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');

const {
  createTestEnvironment,
  runCli,
  startDaemon,
  waitFor
} = require('./helpers');
const {
  CLAUDE_DESKTOP_MODEL_RETENTION_MS,
  HelperRestartBackoff,
  HELPER_HEALTHY_RUN_MS,
  applyClaudeDesktopDisplayOverride,
  getVerifiedClaudeDesktopModel,
  helperRestartDelayMs,
  isVerifiedClaudeDesktopModelFresh,
  resetClaudeDesktopModelCacheForTests,
  setVerifiedClaudeDesktopModel,
  touchVerifiedClaudeDesktopModel
} = require('../dist/adapters/system/claude-desktop-model-watch');
const {
  familiesForForegroundProcess,
  familyForForegroundProcess,
  pickAmbiguousForegroundFamily
} = require('../dist/adapters/system/foreground');
const {
  clearProcessCacheForTests,
  getCachedProcessByPid,
  resetProcessCacheStatsForTests,
  retainSubtreeForTests,
  setCachedProcessList
} = require('../dist/adapters/system/process-cache');
const { toolProviders } = require('../dist/providers/registry');
const { writeWindowsLauncher, LOG_ROTATE_MAX_BYTES } = require('../dist/adapters/startup/service');

const ROOT = path.resolve(__dirname, '..');
const SCHTASKS_MOCK = path.join(__dirname, 'fixtures', 'mock-schtasks-lifecycle.cjs');
const isWindows = process.platform === 'win32';

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-fix-daemon-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

// A harmless long-lived node process; extra argv lets it impersonate the
// daemon command line (`... cli.js daemon`) without being one.
function spawnDecoy(t, extraArgs = []) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...extraArgs], {
    stdio: 'ignore',
    windowsHide: true
  });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch (_) {
      // Already gone.
    }
  });
  return child;
}

// Runs a script in a child node process (keeps execFileSync patches and the
// daemon module's process handlers out of the test runner).
function runNodeScript(script, env) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000
  });
  if (result.status !== 0) {
    throw new Error(`script failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

test('restart stops the running daemon before schtasks /Run (mocked, no real task)', (t) => {
  if (!isWindows) {
    t.skip('Windows scheduled-task path only');
    return;
  }
  const directory = tempDir(t);
  const logFile = path.join(directory, 'schtasks.jsonl');
  const script = `
    const fs = require('node:fs');
    const { restartManagedDaemon } = require(${JSON.stringify(path.join(ROOT, 'dist', 'adapters', 'startup', 'service.js'))});
    const result = restartManagedDaemon({
      macosLaunchAgentId: 'dcs-test',
      windowsTaskName: 'DCS-FixDaemon-Test-${process.pid}',
      stopDaemon: () => fs.appendFileSync(process.env.MOCK_SCHTASKS_LOG, JSON.stringify({ file: 'stop-daemon', args: [] }) + '\\n')
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const stdout = runNodeScript(script, {
    ...process.env,
    MOCK_SCHTASKS_LOG: logFile,
    NODE_OPTIONS: `--require=${SCHTASKS_MOCK}`
  });
  assert.deepEqual(JSON.parse(stdout), { status: 'restarted' });

  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const sequence = calls.map((call) => (call.file === 'stop-daemon' ? 'stop' : call.args[0]));
  assert.deepEqual(sequence, ['/Query', '/End', 'stop', '/Run'], 'the old daemon is stopped after /End and before /Run');
  for (const call of calls.filter((entry) => entry.file !== 'stop-daemon')) {
    assert.ok(call.args.includes(`DCS-FixDaemon-Test-${process.pid}`), 'only the dummy task name is used');
  }
});

test('stopDaemonFromLock kills only a verified daemon PID and leaves foreign PIDs alive', async (t) => {
  if (!isWindows) {
    t.skip('CIM identity check is Windows-only');
    return;
  }
  const { env, directory } = createTestEnvironment(t);
  const lockFile = path.join(directory, 'stop-test.daemon.lock');
  const daemonModule = JSON.stringify(path.join(ROOT, 'dist', 'daemon.js'));

  const foreign = spawnDecoy(t);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: foreign.pid, startedAt: Date.now() }));
  const foreignResult = runNodeScript(
    `process.stdout.write(require(${daemonModule}).stopDaemonFromLock(${JSON.stringify(lockFile)}, { timeoutMs: 3000 }))`,
    env
  );
  assert.equal(foreignResult, 'stale', 'a non-daemon process holding the PID is never killed');
  assert.equal(isAlive(foreign.pid), true);

  const lookalike = spawnDecoy(t, [path.join(directory, 'dist', 'cli.js'), 'daemon']);
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(lockFile, JSON.stringify({ pid: lookalike.pid, startedAt: Date.now() }));
  const stopResult = runNodeScript(
    `process.stdout.write(require(${daemonModule}).stopDaemonFromLock(${JSON.stringify(lockFile)}, { timeoutMs: 5000 }))`,
    env
  );
  assert.equal(stopResult, 'stopped');
  await waitFor(() => !isAlive(lookalike.pid), 'the verified daemon PID to exit', 5000);

  fs.writeFileSync(lockFile, '');
  assert.equal(
    runNodeScript(`process.stdout.write(require(${daemonModule}).stopDaemonFromLock(${JSON.stringify(lockFile)}))`, env),
    'none'
  );
});

test('daemon lock: a live daemon blocks a second instance', async (t) => {
  const { env, stateFile } = createTestEnvironment(t);
  const lockFile = `${stateFile}.daemon.lock`;
  const first = startDaemon(t, env);
  await waitFor(() => first.output().stdout.includes('for hook updates'), 'the first daemon to start');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(lock.pid, first.child.pid);
  assert.equal(typeof lock.startedAt, 'number');

  const second = startDaemon(t, env);
  await waitFor(() => second.child.exitCode !== null, 'the second daemon to exit', 15000);
  assert.equal(second.child.exitCode, 0);
  assert.match(second.output().stdout, /Another daemon instance is already running/);
  assert.equal(first.child.exitCode, null, 'the first daemon keeps running');
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, first.child.pid, 'lock untouched');
});

test('daemon lock: two simultaneous starts yield exactly one daemon', async (t) => {
  const { env, stateFile } = createTestEnvironment(t);
  const a = startDaemon(t, env);
  const b = startDaemon(t, env);
  await waitFor(
    () => a.child.exitCode !== null || b.child.exitCode !== null,
    'one of the racing daemons to exit',
    15000
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const alive = [a, b].filter((daemon) => daemon.child.exitCode === null);
  assert.equal(alive.length, 1, 'exactly one daemon survives the race');
  const lock = JSON.parse(fs.readFileSync(`${stateFile}.daemon.lock`, 'utf8'));
  assert.equal(lock.pid, alive[0].child.pid);
});

test('daemon lock: dead, legacy, foreign and reused PIDs are taken over', async (t) => {
  const cases = [];
  cases.push({ name: 'dead legacy PID', content: () => '999999' });
  if (isWindows) {
    cases.push({
      name: 'live foreign process',
      content: (t2) => JSON.stringify({ pid: spawnDecoy(t2).pid, startedAt: Date.now() + 1000 })
    });
    cases.push({
      name: 'PID reused after the lock was written',
      content: (t2) => JSON.stringify({
        pid: spawnDecoy(t2, ['dist/cli.js', 'daemon']).pid,
        startedAt: Date.now() - 10 * 60_000
      })
    });
  }

  for (const entry of cases) {
    await t.test(entry.name, async (t2) => {
      const { env, stateFile } = createTestEnvironment(t2);
      const lockFile = `${stateFile}.daemon.lock`;
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, entry.content(t2));
      await new Promise((resolve) => setTimeout(resolve, 200));

      const daemon = startDaemon(t2, env);
      await waitFor(() => daemon.output().stdout.includes('for hook updates'), `takeover of a ${entry.name} lock`, 15000);
      assert.match(daemon.output().stdout, /Removing stale daemon lock/);
      assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, daemon.child.pid);
    });
  }
});

test('Desktop model expires 10 minutes after the last Desktop observation', () => {
  resetClaudeDesktopModelCacheForTests();
  const now = Date.now();
  setVerifiedClaudeDesktopModel(4242, 'Opus 5.5', now - CLAUDE_DESKTOP_MODEL_RETENTION_MS - 1000);
  const stale = getVerifiedClaudeDesktopModel();
  assert.equal(isVerifiedClaudeDesktopModelFresh(stale, now), false, 'unobserved for >10 minutes: expired');

  touchVerifiedClaudeDesktopModel(9999, now);
  assert.equal(isVerifiedClaudeDesktopModelFresh(getVerifiedClaudeDesktopModel(), now), false, 'another PID never refreshes it');

  touchVerifiedClaudeDesktopModel(4242, now);
  assert.equal(isVerifiedClaudeDesktopModelFresh(getVerifiedClaudeDesktopModel(), now), true, 'Desktop focus refreshes it');
  assert.equal(
    isVerifiedClaudeDesktopModelFresh(getVerifiedClaudeDesktopModel(), now + CLAUDE_DESKTOP_MODEL_RETENTION_MS + 1),
    false
  );
  resetClaudeDesktopModelCacheForTests();
});

test('retained Desktop model never relabels a Claude Code hook tool with newer activity', () => {
  const observedAt = Date.now() - 60_000;
  const retained = { kind: 'retained', model: 'Opus 5.5', observedAt };
  const newerHook = {
    key: 'state:cli', family: 'claude', source: 'hook', providerId: 'claudeCode',
    details: 'Model: claude-cli-model', state: '', model: 'claude-cli-model', updatedAt: observedAt + 5_000
  };
  const olderHook = { ...newerHook, updatedAt: observedAt - 5_000 };
  const desktopProcess = {
    key: 'claudeApp', family: 'claude', source: 'process', providerId: 'claudeApp',
    details: 'Using Claude', state: 'Claude App', updatedAt: Date.now()
  };

  const kept = applyClaudeDesktopDisplayOverride([newerHook], retained);
  assert.equal(kept[0].details, 'Model: claude-cli-model', 'CLI hook keeps its own model');
  assert.equal(kept[0].providerId, 'claudeCode');

  const desktop = applyClaudeDesktopDisplayOverride([desktopProcess], retained);
  assert.equal(desktop[0].details, 'Model: Opus 5.5', 'the Desktop tool keeps its verified model');

  const older = applyClaudeDesktopDisplayOverride([olderHook], retained);
  assert.equal(older[0].details, 'Model: Opus 5.5', 'Desktop observed after the last hook: Desktop surface shown');
  assert.equal(older[0].providerId, 'claudeApp');

  const focused = applyClaudeDesktopDisplayOverride([newerHook], { kind: 'model', model: 'Opus 5.5' });
  assert.equal(focused[0].details, 'Model: Opus 5.5', 'Desktop foreground: background CLI never supplies the label');
  assert.equal(focused[0].providerId, 'claudeApp');
});

test('helper restart backoff grows 1s to 60s, resets after a healthy run, gives up per PID', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(helperRestartDelayMs), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);

  const backoff = new HelperRestartBackoff(5);
  let now = 1_000_000;
  const delays = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(backoff.canStart(42, now), true);
    backoff.noteStart(42, now);
    delays.push(backoff.noteExit(now + 100));
    assert.equal(backoff.canStart(42, now + 100), false, 'no immediate respawn inside the backoff window');
    now += 100 + delays[delays.length - 1];
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  backoff.noteStart(42, now);
  assert.equal(backoff.noteExit(now + 100), null, '5th consecutive failure gives up');
  assert.equal(backoff.isGivenUp(42), true);
  assert.equal(backoff.canStart(42, now + 10 * 60_000), false, 'stays app-only for the same PID');
  assert.equal(backoff.canStart(43, now), true, 'a new Desktop PID gets a fresh start');
  backoff.noteStart(43, now);
  assert.equal(backoff.isGivenUp(43), false);
  assert.equal(backoff.noteExit(now + 100), 1000);

  const healthy = new HelperRestartBackoff();
  healthy.noteStart(null, 0);
  healthy.noteExit(100);
  healthy.noteStart(null, 2_000);
  assert.equal(healthy.noteExit(2_100), 2000);
  healthy.noteStart(null, 10_000);
  assert.equal(healthy.noteExit(10_000 + HELPER_HEALTHY_RUN_MS), 1000, 'a healthy run resets the backoff');
});

test('one WindowsTerminal hosting Claude Code and Codex CLI resolves by latest hook activity', () => {
  const processes = [
    { pid: 100, line: 'C:/Program Files/WindowsApps/Microsoft.WindowsTerminal/WindowsTerminal.exe', raw: '', executablePath: 'C:/Program Files/WindowsApps/Microsoft.WindowsTerminal/WindowsTerminal.exe' },
    { pid: 101, ppid: 100, line: 'C:/Program Files/PowerShell/7/pwsh.exe', raw: '' },
    { pid: 102, ppid: 101, line: 'C:/Users/u/.local/bin/claude.exe', raw: '', executablePath: 'C:/Users/u/.local/bin/claude.exe' },
    { pid: 103, ppid: 100, line: 'C:/Program Files/PowerShell/7/pwsh.exe', raw: '' },
    { pid: 104, ppid: 103, line: 'C:/Users/u/AppData/Roaming/npm/codex.exe', raw: '', executablePath: 'C:/Users/u/AppData/Roaming/npm/codex.exe' }
  ];
  const families = familiesForForegroundProcess(100, processes, toolProviders).sort();
  assert.deepEqual(families, ['claude', 'codex']);
  assert.equal(familyForForegroundProcess(100, processes, toolProviders), null, 'single-family API stays fail-closed');

  const now = Date.now();
  const tools = [
    { key: 'claude', family: 'claude', source: 'hook', updatedAt: now - 30_000 },
    { key: 'codex', family: 'codex', source: 'hook', updatedAt: now - 1_000 },
    { key: 'grok', family: 'grok', source: 'hook', updatedAt: now }
  ];
  assert.equal(pickAmbiguousForegroundFamily(families, tools), 'codex', 'newest hook among the host families wins');
  assert.equal(pickAmbiguousForegroundFamily(['claude'], tools), 'claude');
  assert.equal(
    pickAmbiguousForegroundFamily(families, tools.map((tool) => ({ ...tool, source: 'process' }))),
    null,
    'no hook evidence keeps the ambiguity unresolved'
  );
});

test('process cache drops retained subtrees that a fresh census proves dead', () => {
  clearProcessCacheForTests();
  resetProcessCacheStatsForTests();
  const deadNode = { pid: 999_991, line: 'C:/Program Files/nodejs/node.exe cli.js', raw: '', executablePath: 'C:/Program Files/nodejs/node.exe' };
  const liveBrowser = { pid: process.pid, line: 'C:/Program Files/Browser/browser.exe', raw: '', executablePath: 'C:/Program Files/Browser/browser.exe' };
  const deadBrowser = { pid: 999_993, line: 'C:/Program Files/Game/game.exe', raw: '', executablePath: 'C:/Program Files/Game/game.exe' };

  retainSubtreeForTests(999_990, [{ pid: 999_990, line: 'C:/x/WindowsTerminal.exe', raw: '', executablePath: 'C:/x/WindowsTerminal.exe' }, deadNode]);
  retainSubtreeForTests(liveBrowser.pid, [liveBrowser], -1);
  retainSubtreeForTests(deadBrowser.pid, [deadBrowser], -1);
  assert.ok(getCachedProcessByPid(deadNode.pid));

  setCachedProcessList([]);
  assert.equal(getCachedProcessByPid(deadNode.pid), null, 'census-enumerated process missing from the census is dead');
  assert.equal(getCachedProcessByPid(999_990), null);
  assert.ok(getCachedProcessByPid(liveBrowser.pid), 'live non-host root stays cached past its TTL (no re-query)');
  assert.equal(getCachedProcessByPid(deadBrowser.pid), null, 'dead non-host root is dropped');
  clearProcessCacheForTests();
  resetProcessCacheStatsForTests();
});

test('launcher rotates daemon logs over 1 MB to .1 before redirecting', (t) => {
  if (!isWindows) {
    t.skip('cmd.exe launcher is Windows-only');
    return;
  }
  const directory = tempDir(t);
  const installDirectory = path.join(directory, 'app');
  const logDirectory = path.join(directory, 'logs');
  const scriptPath = path.join(directory, 'noop.js');
  fs.writeFileSync(scriptPath, "process.stdout.write('fresh\\n');\n");
  const launcher = writeWindowsLauncher(scriptPath, { installDirectory, logDirectory });

  const outLog = path.join(logDirectory, 'discord-coding-status.log');
  const errLog = path.join(logDirectory, 'discord-coding-status.error.log');
  fs.writeFileSync(outLog, Buffer.alloc(LOG_ROTATE_MAX_BYTES + 10, 65));
  fs.writeFileSync(`${outLog}.1`, 'older rotation');
  fs.writeFileSync(errLog, 'small error log\n');

  const result = spawnSync('cmd.exe', ['/d', '/c', launcher], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);

  assert.equal(fs.statSync(`${outLog}.1`).size, LOG_ROTATE_MAX_BYTES + 10, 'oversized log moved to .1 (one old file kept)');
  assert.equal(fs.readFileSync(outLog, 'utf8'), 'fresh\n', 'a new log is started');
  assert.equal(fs.existsSync(`${errLog}.1`), false, 'logs under the limit are not rotated');
  assert.equal(fs.readFileSync(errLog, 'utf8'), 'small error log\n');
});

test('slow census idles at 60s without AI activity and returns to active on a hook', async (t) => {
  const { env } = createTestEnvironment(t, {
    DISCORD_CODING_STATUS_DEBUG: '1',
    DISCORD_CODING_STATUS_POLL_INTERVAL_MS: '200'
  });
  const daemon = startDaemon(t, env);
  await waitFor(() => daemon.output().stdout.includes('Slow census idle; next in 60000ms.'), 'idle census mode', 15000);

  await runCli([
    'hook', '--tool', 'codex', '--surface', 'cli', '--status', 'running',
    '--session-id', 'census-wake', '--cwd', ROOT, '--model', 'model-census'
  ], env);
  const afterIdle = () => {
    const stdout = daemon.output().stdout;
    return stdout.slice(stdout.indexOf('Slow census idle; next in 60000ms.'));
  };
  await waitFor(() => /Slow census active; next in \d+ms\./.test(afterIdle()), 'active census mode after a hook', 15000);
  const afterWake = () => afterIdle().slice(afterIdle().indexOf('Slow census active'));
  await waitFor(
    () => afterWake().split('Slow census cached').length - 1 >= 3,
    'repeated censuses at the active interval (not 60s)',
    10000
  );
});
