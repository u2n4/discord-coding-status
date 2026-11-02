'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const {
  rememberLastFocusedFamily,
  resolveEffectivePreferredFamily,
  getLastFocusedFamily,
  resetLastFocusedFamilyForTests
} = require('../dist/core/selection/last-focused');
const { selectNewestTool } = require('../dist/presence');
const { familyForForegroundProcess } = require('../dist/adapters/system/foreground');
const { detectActiveTools } = require('../dist/core/detection/active-tools');
const { toolProviders } = require('../dist/providers/registry');
const {
  buildForegroundSamplerScript,
  resolveForegroundSampleMs,
  isForegroundWatchEnabled,
  startForegroundWatcher,
  stopForegroundWatcher,
  isForegroundWatcherHealthy,
  getForegroundWatcherStats,
  resetForegroundWatcherForTests,
  FOREGROUND_WATCH_SAMPLE_MS_DEFAULT
} = require('../dist/adapters/system/foreground-watch');
const {
  getCachedProcessByPid,
  setCachedProcessList,
  refreshProcessForPid,
  getProcessCacheStats,
  clearProcessCacheForTests,
  resetProcessCacheStatsForTests
} = require('../dist/adapters/system/process-cache');
const { enrichToolForPresence } = require('../dist/presence');
const {
  createTestEnvironment,
  readRpcEvents,
  runCli,
  startDaemon,
  waitFor
} = require('./helpers');

const NOW = 1787131925747;

function hookTool(family, ageMs, extra = {}) {
  return {
    key: `state:${family}`,
    family,
    source: 'hook',
    updatedAt: NOW - ageMs,
    details: `Model: ${family}-model`,
    state: '',
    ...extra
  };
}

function processInfo(pid, line, executablePath, ppid) {
  return { pid, ppid, line, raw: line, executablePath, commandLine: line };
}

test('A->B->Discord/browser retains B instead of reverting to the newest hook', () => {
  resetLastFocusedFamilyForTests();
  const alive = ['claude', 'codex'];
  // A (claude) is newer than B (codex): without focus retention the newest (A) wins.
  const newerA = hookTool('claude', 1000);
  const olderB = hookTool('codex', 60000);

  assert.equal(selectNewestTool([newerA, olderB]), newerA, 'baseline: newest hook wins with no focus');

  assert.equal(rememberLastFocusedFamily('claude', alive), 'claude');
  assert.equal(rememberLastFocusedFamily('codex', alive), 'codex');
  // Discord/browser focus arrives as null (non-AI): B must be retained.
  assert.equal(rememberLastFocusedFamily(null, alive), 'codex');
  assert.equal(getLastFocusedFamily(), 'codex');

  const effective = getLastFocusedFamily();
  assert.equal(selectNewestTool([newerA, olderB], effective), olderB);
  assert.equal(selectNewestTool([olderB, newerA], effective), olderB);
  assert.equal(resolveEffectivePreferredFamily(null, 'codex', alive), 'codex');
});

test('games are ignored and never shown; unrelated focus retains the AI', () => {
  resetLastFocusedFamilyForTests();
  const alive = ['codex'];
  assert.equal(rememberLastFocusedFamily('codex', alive), 'codex');

  const game = processInfo(
    9000,
    'C:\\Games\\EldenRing\\eldenring.exe',
    'C:\\Games\\EldenRing\\eldenring.exe'
  );
  assert.equal(familyForForegroundProcess(9000, [game], toolProviders), null);

  const detected = detectActiveTools(
    [{ line: 'C:\\Games\\EldenRing\\eldenring.exe', pid: 9000, cpuMs: 10000 }],
    toolProviders,
    { idleGraceMs: 5 * 60_000, activeCpuMs: 0 }
  );
  assert.ok(detected.every((tool) => tool.family !== 'game'), 'no game family is ever detected');

  // Game focus is null attribution: the remembered AI survives.
  assert.equal(rememberLastFocusedFamily(null, alive), 'codex');
  assert.equal(getLastFocusedFamily(), 'codex');
});

test('a dead remembered family falls back instead of sticking', () => {
  resetLastFocusedFamilyForTests();
  assert.equal(rememberLastFocusedFamily('codex', ['claude', 'codex']), 'codex');

  // B dies: null focus with only A alive clears the memory.
  assert.equal(rememberLastFocusedFamily(null, ['claude']), null);
  assert.equal(getLastFocusedFamily(), null);

  // A stale B foreground event after death also clears (never returns the dead family).
  assert.equal(rememberLastFocusedFamily('codex', ['claude', 'codex']), 'codex');
  assert.equal(rememberLastFocusedFamily('codex', ['claude']), null);
  assert.equal(getLastFocusedFamily(), null);

  const fallbackA = hookTool('claude', 5000);
  assert.equal(selectNewestTool([fallbackA], null), fallbackA);
});

test('families without a Discord ID are excluded from last-focused memory', () => {
  resetLastFocusedFamilyForTests();
  // Alive set already excludes the ID-less family (presence filters by clientId).
  assert.equal(rememberLastFocusedFamily('claude', ['claude']), 'claude');
  // An ID-less foreground family is not in the alive set: ignored, previous kept.
  assert.equal(rememberLastFocusedFamily('muse', ['claude']), 'claude');
  assert.equal(getLastFocusedFamily(), 'claude');
  assert.equal(resolveEffectivePreferredFamily('muse', 'claude', ['claude']), 'claude');
  assert.equal(resolveEffectivePreferredFamily(null, 'muse', ['claude']), null);
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

function writeMuseExecSession(sessionsRoot, sessionId, pid, modelId, startedAtMs, sequenceBase = 4) {
  const micros = (ms) => ms * 1000;
  const records = [
    {
      schema_version: 1,
      stream: { kind: 'session', id: sessionId },
      sequence: sequenceBase,
      recorded_at: micros(startedAtMs + 10),
      payload_type: 'runtime.session.route_facts',
      payload: { kind: 'route_facts', record: { pid } }
    },
    {
      schema_version: 1,
      stream: { kind: 'session', id: sessionId },
      sequence: sequenceBase + 24,
      recorded_at: micros(startedAtMs + 1000),
      payload_type: 'run.model.configured',
      payload: { kind: 'run_model', record: { model_id: modelId } }
    }
  ];
  const directory = path.join(sessionsRoot, '2026', '10', '27', sessionId);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'session.jsonl');
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

function appendMuseModelRecord(file, sessionId, modelId, recordedAtMs, sequence) {
  const record = {
    schema_version: 1,
    stream: { kind: 'session', id: sessionId },
    sequence,
    recorded_at: recordedAtMs * 1000,
    payload_type: 'run.model.configured',
    payload: { kind: 'run_model', record: { model_id: modelId } }
  };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

test('a selected bound model change applies with no new focus event', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-focus-muse-'));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = scratch;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previous;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const sessionsRoot = path.join(scratch, 'muse', 'sessions');
  const startedAt = Date.now();
  const file = writeMuseExecSession(sessionsRoot, EXEC_UUID, 42712, 'muse-spark-1.3', startedAt);
  const tool = {
    key: 'museCli',
    family: 'muse',
    providerId: 'museCli',
    source: 'process',
    details: 'Using Muse',
    state: 'Muse Code',
    processInfo: execProcessInfo(42712, EXEC_UUID, startedAt)
  };

  const first = await enrichToolForPresence(tool);
  assert.equal(first.details, 'Model: Muse Spark 1.3');

  // Genuine model switch in the same bound session: no focus event involved.
  appendMuseModelRecord(file, EXEC_UUID, 'muse-spark-1.4', startedAt + 5000, 128);
  const second = await enrichToolForPresence(tool);
  assert.equal(second.details, 'Model: Muse Spark 1.4');
});

test('a bound background exec never labels an unknown foreground TUI after a model change', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-focus-ambiguous-'));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = scratch;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previous;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const sessionsRoot = path.join(scratch, 'muse', 'sessions');
  const startedAt = Date.now();
  const file = writeMuseExecSession(sessionsRoot, EXEC_UUID, 42712, 'muse-spark-1.3', startedAt);
  appendMuseModelRecord(file, EXEC_UUID, 'muse-spark-1.4', startedAt + 5000, 128);

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
  assert.equal(muse.processAmbiguous, true);

  const enriched = await enrichToolForPresence({
    key: 'museCli',
    family: 'muse',
    providerId: 'museCli',
    source: 'process',
    details: 'Using Muse',
    state: 'Muse Code',
    processInfo: exec,
    processAmbiguous: true
  });
  assert.equal(enriched.details, '', 'ambiguous TUI stays app-only even when the bound file changes');
});

test('rapid A/B hook updates converge on the latest without republishing stale A', async (t) => {
  const { env, rpcLogFile } = createTestEnvironment(t);
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  const base = ['hook', '--tool', 'codex', '--surface', 'cli', '--status', 'running'];
  await runCli([...base, '--session-id', 'rapid-a', '--cwd', process.cwd(), '--model', 'model-rapid-a'], env);
  await runCli([...base, '--session-id', 'rapid-b', '--cwd', process.cwd(), '--model', 'model-rapid-b'], env);

  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity' && event.activity.details === 'Model: model-rapid-b'
    ),
    'the latest rapid model to reach Discord RPC'
  );

  // Give any stale queued write a chance to (incorrectly) land after B.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const sets = readRpcEvents(rpcLogFile).filter((event) => event.method === 'setActivity');
  assert.ok(sets.length >= 1);
  const last = sets[sets.length - 1];
  assert.equal(last.activity.details, 'Model: model-rapid-b', 'stale A must never be republished after B');

  const firstB = sets.findIndex((event) => event.activity.details === 'Model: model-rapid-b');
  assert.ok(firstB >= 0);
  const staleAfterB = sets.slice(firstB + 1).filter(
    (event) => event.activity.details === 'Model: model-rapid-a'
  );
  assert.equal(staleAfterB.length, 0, 'no A write may land after the first B write');
  assert.equal(daemon.output().stderr, '');
});

test('fast attribution uses the cache; unknown-PID refresh is bounded and deduped', async () => {
  clearProcessCacheForTests();
  resetProcessCacheStatsForTests();

  const terminal = processInfo(100, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const museChild = processInfo(
    101,
    'C:\\Programs\\muse\\muse-bin-1.4.13.exe',
    'C:\\Programs\\muse\\muse-bin-1.4.13.exe',
    100
  );
  setCachedProcessList([terminal, museChild]);

  assert.equal(getCachedProcessByPid(101)?.pid, 101);
  assert.equal(getCachedProcessByPid(999999), null);

  // Known PIDs never trigger a refresh query.
  const before = getProcessCacheStats();
  await refreshProcessForPid(101);
  await refreshProcessForPid(100);
  const afterKnown = getProcessCacheStats();
  assert.equal(afterKnown.refreshAttempts, before.refreshAttempts);

  // Invalid PIDs are no-ops without attempts.
  await refreshProcessForPid(0);
  await refreshProcessForPid(-5);
  assert.equal(getProcessCacheStats().refreshAttempts, before.refreshAttempts);

  // Attribution itself is pure cache work (no spawn).
  assert.equal(
    familyForForegroundProcess(100, [terminal, museChild], toolProviders),
    'muse'
  );

  clearProcessCacheForTests();
  resetProcessCacheStatsForTests();
});

test('foreground sampler interval stays in the approved 100-150ms band', (t) => {
  assert.ok(
    FOREGROUND_WATCH_SAMPLE_MS_DEFAULT >= 100 && FOREGROUND_WATCH_SAMPLE_MS_DEFAULT <= 150,
    `default ${FOREGROUND_WATCH_SAMPLE_MS_DEFAULT}ms must be within 100-150ms`
  );

  const previous = process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS;
    } else {
      process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = previous;
    }
  });

  delete process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS;
  assert.equal(resolveForegroundSampleMs(), FOREGROUND_WATCH_SAMPLE_MS_DEFAULT);

  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = '';
  assert.equal(resolveForegroundSampleMs(), FOREGROUND_WATCH_SAMPLE_MS_DEFAULT, 'empty override falls back to 120ms, not MIN');
  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = '   ';
  assert.equal(resolveForegroundSampleMs(), FOREGROUND_WATCH_SAMPLE_MS_DEFAULT, 'whitespace override falls back to 120ms');
  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = '0';
  assert.equal(resolveForegroundSampleMs(), FOREGROUND_WATCH_SAMPLE_MS_DEFAULT, 'zero interval is invalid');
  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = '-5';
  assert.equal(resolveForegroundSampleMs(), FOREGROUND_WATCH_SAMPLE_MS_DEFAULT, 'negative interval is invalid');
  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = 'Infinity';
  assert.equal(resolveForegroundSampleMs(), FOREGROUND_WATCH_SAMPLE_MS_DEFAULT, 'non-finite override falls back');
  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = '120';
  assert.equal(resolveForegroundSampleMs(), 120);
  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = ' 120 ';
  assert.equal(resolveForegroundSampleMs(), 120, 'surrounding whitespace is trimmed');
  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = '100';
  assert.equal(resolveForegroundSampleMs(), 100, 'approved band lower bound passes through');
  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = '150';
  assert.equal(resolveForegroundSampleMs(), 150, 'approved band upper bound passes through');

  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = '10';
  assert.equal(resolveForegroundSampleMs(), 50);
  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = '5000';
  assert.equal(resolveForegroundSampleMs(), 1000);
  process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS = 'not-a-number';
  assert.equal(resolveForegroundSampleMs(), FOREGROUND_WATCH_SAMPLE_MS_DEFAULT);
});

test('foreground watch toggle honors the off switch', (t) => {
  const previous = process.env.DISCORD_CODING_STATUS_FOREGROUND_WATCH;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.DISCORD_CODING_STATUS_FOREGROUND_WATCH;
    } else {
      process.env.DISCORD_CODING_STATUS_FOREGROUND_WATCH = previous;
    }
  });

  delete process.env.DISCORD_CODING_STATUS_FOREGROUND_WATCH;
  assert.equal(isForegroundWatchEnabled(), true);
  process.env.DISCORD_CODING_STATUS_FOREGROUND_WATCH = 'off';
  assert.equal(isForegroundWatchEnabled(), false);
  process.env.DISCORD_CODING_STATUS_FOREGROUND_WATCH = 'ON';
  assert.equal(isForegroundWatchEnabled(), true);
});

test('sampler script compiles one event-driven helper, emits PID-only, and self-exits on parent death/stdin EOF', () => {
  const script = buildForegroundSamplerScript(4242, 120);

  const addTypeCount = (script.match(/Add-Type/g) || []).length;
  assert.equal(addTypeCount, 1, 'Add-Type must run once per helper lifetime');

  assert.match(script, /SetWinEventHook\(3, 3,/, 'EVENT_SYSTEM_FOREGROUND hook, no polling loop in script');
  assert.match(script, /GetForegroundWindow/);
  assert.match(script, /GetWindowThreadProcessId/);
  assert.match(script, /Process\.GetProcessById\(parent\)/, 'parent liveness is checked');
  assert.match(script, /OpenStandardInput/, 'stdin EOF ends the helper');
  assert.match(script, /Thread\.Sleep\(sampleMs\)/, 'polling fallback when the hook cannot be installed');

  const writeCount = (script.match(/Console\.Out\.WriteLine/g) || []).length;
  assert.equal(writeCount, 1, 'exactly one PID-only emission point');

  assert.doesNotMatch(script, /WindowText/);
  assert.doesNotMatch(script, /GetTitle/);
  assert.doesNotMatch(script, /\.Title\b/);
  // Never name a variable $pid (PowerShell automatic variable); sampler uses $watch*.
  assert.doesNotMatch(script, /\$pid\b/i);

  assert.match(script, /\$ErrorActionPreference='Stop'/, 'no blanket SilentlyContinue');
  assert.doesNotMatch(script, /SilentlyContinue/, 'startup/native errors must surface, not suppress');
  assert.match(script, /type-load failed/, 'Add-Type failure exits visibly');
  assert.match(script, /exit 2/, 'startup failure exits for fallback');
  assert.match(script, /failures >= 20/, 'consecutive native failures are bounded');
  assert.match(script, /Environment\.Exit\(3\)/, 'native API failure exits for fallback');
  assert.match(script, /\$watchParent -le 0/, 'invalid parent PID is rejected in-script');
  assert.match(script, /Console\.Error\.WriteLine|Write-Error/, 'failures go to stderr, stdout stays PID-only');
});

test('sampler script rejects an invalid parent PID instead of watching Idle (0)', () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.throws(
      () => buildForegroundSamplerScript(bad, 120),
      /Invalid parent PID/,
      `parent ${String(bad)} must reject`
    );
  }
  const script = buildForegroundSamplerScript(4242, 120);
  assert.match(script, /\$watchParent=4242/);
});

test('sampler script falls back to 120ms on an invalid cadence instead of NaN', () => {
  for (const bad of [NaN, 0, -10]) {
    const script = buildForegroundSamplerScript(4242, bad);
    assert.match(script, /\$watchSample=120/, `sample ${String(bad)} falls back to 120ms`);
    assert.doesNotMatch(script, /NaN/, 'NaN must never reach Start-Sleep');
  }
  assert.match(buildForegroundSamplerScript(4242, 10), /\$watchSample=50/);
  assert.match(buildForegroundSamplerScript(4242, 5000), /\$watchSample=1000/);
});

test('watcher startup rejects an invalid parent PID visibly without spawning', () => {
  resetForegroundWatcherForTests();
  try {
    const handle = startForegroundWatcher(() => {}, () => {}, { parentPid: 0 });
    assert.equal(handle, null, 'invalid parent must not spawn');
    const stats = getForegroundWatcherStats();
    assert.equal(stats.available, false);
    assert.match(stats.lastError || '', /invalid parent PID/i);
    assert.equal(isForegroundWatcherHealthy(), false);
  } finally {
    resetForegroundWatcherForTests();
  }
});

async function waitForCondition(predicate, timeoutMs, pollMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

test('foreground helper cleans up on normal stop without orphaning', { skip: process.platform !== 'win32' }, async (t) => {
  resetForegroundWatcherForTests();
  t.after(() => resetForegroundWatcherForTests());

  const handle = startForegroundWatcher(() => {});
  assert.ok(handle, 'expected the sampler to start on Windows');
  assert.equal(isForegroundWatcherHealthy(), true);

  const stats = getForegroundWatcherStats();
  assert.ok(stats.pid && stats.pid > 0);
  assert.ok(isPidAlive(stats.pid), 'sampler child must be alive after start');

  // A second start while healthy must reuse the singleton, not spawn again.
  const second = startForegroundWatcher(() => {});
  assert.equal(second?.pid, handle.pid);
  assert.equal(getForegroundWatcherStats().restarts, 0);

  stopForegroundWatcher();
  const exited = await waitForCondition(() => !isPidAlive(stats.pid), 5000);
  assert.equal(exited, true, 'sampler child must exit after stop (no orphan)');
  assert.equal(isForegroundWatcherHealthy(), false);
});

test('foreground helper self-exits when the parent PID is gone', { skip: process.platform !== 'win32' }, async () => {
  const fakeParent = 999999;
  assert.equal(isPidAlive(fakeParent), false, 'fake parent PID must not exist for this test');

  const script = buildForegroundSamplerScript(fakeParent, 120);
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  });
  assert.ok(child.pid);

  try {
    child.stdin?.on('error', () => {});
    const exited = await waitForCondition(() => child.exitCode !== null, 8000, 100);
    assert.equal(exited, true, 'sampler must self-exit on parent death');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    try {
      child.stdin?.destroy();
    } catch (_) {}
  }

  assert.equal(isPidAlive(child.pid), false, 'no orphan after parent-death exit');
});

test('foreground helper self-exits on stdin EOF', { skip: process.platform !== 'win32' }, async () => {
  const script = buildForegroundSamplerScript(process.pid, 120);
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  });
  assert.ok(child.pid);

  try {
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.end();
    } catch (_) {}

    const exited = await waitForCondition(() => child.exitCode !== null, 8000, 100);
    assert.equal(exited, true, 'sampler must self-exit on stdin EOF');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    try {
      child.stdin?.destroy();
    } catch (_) {}
  }

  assert.equal(isPidAlive(child.pid), false, 'no orphan after stdin-EOF exit');
});
