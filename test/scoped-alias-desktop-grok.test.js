'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const { getActivitySignature, selectNewestTool } = require('../dist/presence');
const {
  isClaudeDesktopModelButtonName,
  parseClaudeDesktopModelChildLabel,
  selectClaudeDesktopModel
} = require('../dist/core/detection/claude-desktop-model');
const {
  buildClaudeDesktopModelSamplerScript,
  applyClaudeDesktopDisplayOverride,
  getVerifiedClaudeDesktopModel,
  setVerifiedClaudeDesktopModel,
  clearVerifiedClaudeDesktopModel,
  resetClaudeDesktopModelWatcherForTests,
  resetClaudeDesktopModelCacheForTests,
  startClaudeDesktopModelWatcher,
  stopClaudeDesktopModelWatcher,
  isClaudeDesktopModelWatcherHealthy,
  getClaudeDesktopModelWatcherStats
} = require('../dist/adapters/system/claude-desktop-model-watch');
const {
  createTestEnvironment,
  readRpcEvents,
  runCli,
  startDaemon,
  waitFor
} = require('./helpers');

function countOccurrences(haystack, needle) {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function hasPidVariable(script) {
  const lower = script.toLowerCase();
  let index = lower.indexOf('$pid');
  while (index !== -1) {
    const next = lower.charAt(index + 4);
    const isWord = (next >= 'a' && next <= 'z') || (next >= '0' && next <= '9') || next === '_';
    if (!next || !isWord) {
      return true;
    }
    index = lower.indexOf('$pid', index + 1);
  }
  return false;
}

async function waitForCondition(predicate, timeoutMs, pollMs) {
  const gap = pollMs || 50;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, gap));
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

test('identical Claude aliases share one activity signature (key excluded)', () => {
  const claude = { key: 'claude', family: 'claude', providerId: 'claudeCode', details: '', state: '' };
  const claudeApp = { key: 'claudeApp', family: 'claude', providerId: 'claudeApp', details: '', state: '' };
  assert.equal(getActivitySignature(claude), getActivitySignature(claudeApp), 'same app + payload must dedup across aliases');

  const withModelA = { key: 'state:aaa', family: 'claude', source: 'hook', details: 'Model: Opus 5.5', state: '' };
  const withModelB = { key: 'state:bbb', family: 'claude', source: 'hook', details: 'Model: Opus 5.5', state: '' };
  assert.equal(getActivitySignature(withModelA), getActivitySignature(withModelB), 'session key must not split identical payloads');
});

test('genuine model/app/payload changes produce a new signature', () => {
  const base = { key: 'claude', family: 'claude', providerId: 'claudeCode', details: 'Model: Opus 5.5', state: '' };
  const changed = { key: 'claude', family: 'claude', providerId: 'claudeCode', details: 'Model: Sonnet 5.5', state: '' };
  assert.notEqual(getActivitySignature(base), getActivitySignature(changed), 'model change must publish');

  const appOnly = { key: 'claude', family: 'claude', providerId: 'claudeCode', details: '', state: '' };
  assert.notEqual(getActivitySignature(base), getActivitySignature(appOnly), 'model loss must publish');

  const otherApp = { key: 'codexCli', family: 'codex', providerId: 'codexCli', details: 'Model: Opus 5.5', state: '' };
  assert.notEqual(getActivitySignature(base), getActivitySignature(otherApp), 'different Discord app must differ even with the same model line');
});

test('foreground Codex wins over a newer background Muse hook (no takeover)', () => {
  const now = Date.now();
  const museNewer = { key: 'state:muse', family: 'muse', source: 'hook', updatedAt: now, details: 'Model: muse-new', state: '' };
  const codexOlder = { key: 'state:codex', family: 'codex', source: 'hook', updatedAt: now - 60000, details: 'Model: codex-old', state: '' };
  assert.equal(selectNewestTool([museNewer, codexOlder]), museNewer, 'baseline: newest wins without focus');
  assert.equal(selectNewestTool([museNewer, codexOlder], 'codex'), codexOlder, 'foreground family wins over newer background');
  assert.equal(selectNewestTool([codexOlder, museNewer], 'codex'), codexOlder);
});

test('identical session payloads with different keys publish once', async (t) => {
  const { env, rpcLogFile, stateFile } = createTestEnvironment(t);
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  const older = Date.now() - 1000;
  const newer = Date.now();
  const sessionA = {
    tool: 'claude',
    surface: 'cli',
    status: 'running',
    session_id: 'flip-a',
    cwd: process.cwd(),
    updated_at: older,
    started_at: older,
    model: 'flip-model-same'
  };
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: { 'flip-a': sessionA } }));

  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity' && event.activity.details === 'Model: flip-model-same'
    ),
    'the first identical payload to reach Discord RPC'
  );

  const sessionB = {
    tool: 'claude',
    surface: 'cli',
    status: 'running',
    session_id: 'flip-b',
    cwd: process.cwd(),
    updated_at: newer,
    started_at: newer,
    model: 'flip-model-same'
  };
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: { 'flip-a': sessionA, 'flip-b': sessionB } }));

  await new Promise((resolve) => setTimeout(resolve, 600));

  const sets = readRpcEvents(rpcLogFile).filter(
    (event) => event.method === 'setActivity' && event.activity.details === 'Model: flip-model-same'
  );
  assert.equal(sets.length, 1, 'identical payload with a new session key must not republish');
  assert.equal(daemon.output().stderr, '');
});

test('a genuine selected-model change publishes a new payload', async (t) => {
  const { env, rpcLogFile } = createTestEnvironment(t);
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  const base = ['hook', '--tool', 'claude', '--surface', 'cli', '--status', 'running', '--session-id', 'chg-1', '--cwd', process.cwd()];
  await runCli([...base, '--model', 'model-before'], env);
  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity' && event.activity.details === 'Model: model-before'
    ),
    'the first model to reach Discord RPC'
  );

  await runCli([...base, '--model', 'model-after'], env);
  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity' && event.activity.details === 'Model: model-after'
    ),
    'the changed model to reach Discord RPC'
  );

  const sets = readRpcEvents(rpcLogFile).filter((event) => event.method === 'setActivity');
  assert.ok(sets.length >= 2, 'expected a Discord update for both models');
  assert.equal(sets[sets.length - 1].activity.details, 'Model: model-after');
  assert.equal(daemon.output().stderr, '');
});

test('Desktop UI label binds positive PID/control and rejects wrong PID/Menu/ambiguous/missing', () => {
  const binding = { pid: 23764, hwnd: 2427202 };
  const button = (overrides) => ({
    pid: 23764,
    hwnd: 2427202,
    controlType: 'Button',
    name: 'Model: Opus 5.5 Extra',
    modelChildLabel: 'Opus 5.5',
    ...overrides
  });

  assert.equal(selectClaudeDesktopModel([button({})], binding), 'Opus 5.5');
  assert.equal(isClaudeDesktopModelButtonName('Model: Opus 5.5 Extra'), true);
  assert.equal(parseClaudeDesktopModelChildLabel('Model: Opus 5.5 Extra', 'Opus 5.5'), 'Opus 5.5');

  assert.equal(selectClaudeDesktopModel([button({ pid: 11111 })], binding), null, 'wrong PID fails closed');
  assert.equal(selectClaudeDesktopModel([button({ hwnd: 999999 })], binding), null, 'wrong HWND fails closed');
  assert.equal(selectClaudeDesktopModel([button({})], { pid: 11111, hwnd: 2427202 }), null, 'binding PID mismatch fails closed');

  assert.equal(selectClaudeDesktopModel([button({ controlType: 'Menu' })], binding), null, 'menu with the same Name is never read as the button');
  assert.equal(selectClaudeDesktopModel([button({ controlType: 'MenuItem' })], binding), null);

  assert.equal(selectClaudeDesktopModel([button({}), button({})], binding), null, 'ambiguous duplicate buttons fail closed');

  assert.equal(selectClaudeDesktopModel([button({ modelChildLabel: null })], binding), null, 'missing child fails closed');
  assert.equal(selectClaudeDesktopModel([button({ modelChildLabel: '' })], binding), null);
  assert.equal(selectClaudeDesktopModel([button({ modelChildLabel: '   ' })], binding), null);

  const submit = button({ name: 'Submit', modelChildLabel: 'Submit' });
  assert.equal(selectClaudeDesktopModel([submit], binding), null, 'non-matching buttons are ignored');
  const edit = { pid: 23764, hwnd: 2427202, controlType: 'Edit', name: 'conversation text', modelChildLabel: 'hello' };
  assert.equal(selectClaudeDesktopModel([edit], binding), null, 'generic UI text is never captured');
  assert.equal(selectClaudeDesktopModel([submit, edit, button({})], binding), 'Opus 5.5', 'noise ignored, single button still binds');

  assert.equal(selectClaudeDesktopModel([button({})], { pid: 0, hwnd: 2427202 }), null, 'invalid binding fails closed');
  assert.equal(selectClaudeDesktopModel([button({})], { pid: 23764, hwnd: 0 }), null);
  assert.equal(selectClaudeDesktopModel([], binding), null);
});

test('Desktop effort is excluded: first child only, never button suffix or later child', () => {
  const binding = { pid: 23764, hwnd: 2427202 };
  assert.equal(parseClaudeDesktopModelChildLabel('Model: Opus 5.5 Extra', 'Opus 5.5'), 'Opus 5.5');
  const candidate = { pid: 23764, hwnd: 2427202, controlType: 'Button', name: 'Model: Opus 5.5 Extra', modelChildLabel: 'Opus 5.5' };
  assert.equal(selectClaudeDesktopModel([candidate], binding), 'Opus 5.5');

  const mismatched = { pid: 23764, hwnd: 2427202, controlType: 'Button', name: 'Model: WRONG-GUESS', modelChildLabel: 'Opus 5.5' };
  assert.equal(selectClaudeDesktopModel([mismatched], binding), 'Opus 5.5', 'model comes from the first child, never the button suffix');

  assert.equal(parseClaudeDesktopModelChildLabel('Opus 5.5', 'Opus 5.5'), null, 'missing prefix is not a model button');
  assert.equal(parseClaudeDesktopModelChildLabel('Model:', 'Opus 5.5'), null, 'bare prefix without content is not a button');
  assert.equal(parseClaudeDesktopModelChildLabel(null, 'Opus 5.5'), null);
});

test('Desktop model change while the same HWND stays focused resolves the new label', () => {
  const binding = { pid: 23764, hwnd: 2427202 };
  const before = { pid: 23764, hwnd: 2427202, controlType: 'Button', name: 'Model: Opus 5.5 Extra', modelChildLabel: 'Opus 5.5' };
  const after = { pid: 23764, hwnd: 2427202, controlType: 'Button', name: 'Model: Sonnet 5.5 Extra', modelChildLabel: 'Sonnet 5.5' };
  assert.equal(selectClaudeDesktopModel([before], binding), 'Opus 5.5');
  assert.equal(selectClaudeDesktopModel([after], binding), 'Sonnet 5.5', 'same window, new picker selection resolves');
});

test('Desktop override replaces a stale sibling CLI label; null override preserves CLI', () => {
  resetClaudeDesktopModelCacheForTests();
  const hookClaude = { key: 'state:cli-1', family: 'claude', source: 'hook', details: 'Model: stale-cli-model', state: '', model: 'stale-cli-model' };
  const codex = { key: 'codexCli', family: 'codex', source: 'process', details: 'Model: gpt-x', state: '' };

  const overridden = applyClaudeDesktopDisplayOverride([hookClaude, codex], { kind: 'model', model: 'Opus 5.5' });
  assert.equal(overridden[0].details, 'Model: Opus 5.5', 'Desktop UI wins over background CLI hook model');
  assert.equal(overridden[0].state, '');
  assert.equal(overridden[1].details, 'Model: gpt-x', 'other families untouched');

  const appOnly = applyClaudeDesktopDisplayOverride([hookClaude], { kind: 'app-only' });
  assert.equal(appOnly[0].details, '', 'fail-closed Desktop foreground clears stale CLI to app-only');
  assert.equal(appOnly[0].state, '');

  const preserved = applyClaudeDesktopDisplayOverride([hookClaude], null);
  assert.equal(preserved[0].details, 'Model: stale-cli-model', 'no override (CLI foreground) preserves hook model');

  const empty = applyClaudeDesktopDisplayOverride([hookClaude], { kind: 'model', model: '   ' });
  assert.equal(empty[0].details, '', 'empty UI label fails closed');

  setVerifiedClaudeDesktopModel(23764, 'Opus 5.5');
  const cached = getVerifiedClaudeDesktopModel();
  assert.equal(cached.pid, 23764);
  assert.equal(cached.model, 'Opus 5.5');
  setVerifiedClaudeDesktopModel(0, 'Bad');
  assert.equal(getVerifiedClaudeDesktopModel().pid, 23764, 'invalid PID ignored');
  setVerifiedClaudeDesktopModel(23764, '   ');
  assert.equal(getVerifiedClaudeDesktopModel().model, 'Opus 5.5', 'empty label ignored');
  clearVerifiedClaudeDesktopModel();
  assert.equal(getVerifiedClaudeDesktopModel(), null);
  resetClaudeDesktopModelCacheForTests();
});

test('Desktop sampler script is Button-scoped, prefix-filtered, and orphan-safe', () => {
  const script = buildClaudeDesktopModelSamplerScript(23764, 4242, 500);
  assert.equal(script.includes('Add-Type -AssemblyName UIAutomationClient'), true);
  assert.equal(script.includes('Add-Type -Namespace Win32 -Name ClaudeDesktopModelSampler'), true);
  assert.equal(countOccurrences(script, 'Add-Type'), 2);
  assert.equal(script.includes('AutomationElement'), true);
  assert.equal(script.includes('FromHandle'), true);
  assert.equal(script.includes('FindAll'), true);
  assert.equal(script.includes('FindFirst'), true);
  assert.equal(script.includes('ControlType]::Button'), true);
  assert.equal(script.includes('ControlType]::Text'), true);
  assert.equal(script.includes("StartsWith('Model:')"), true);
  assert.equal(script.includes('MODEL|'), true);
  assert.equal(script.includes('UNBOUND'), true);
  assert.equal(script.includes('UNAVAILABLE'), true);
  assert.equal(countOccurrences(script, 'Write-Output'), 1, 'single state emission point');
  assert.equal(script.includes('GetForegroundWindow'), true);
  assert.equal(script.includes('GetWindowThreadProcessId'), true);
  assert.equal(script.includes('Get-Process -Id $watchParent'), true);
  assert.equal(script.includes('BeginRead'), true);
  assert.equal(script.includes('EndRead'), true);
  assert.equal(script.includes('WaitOne(0)'), true);
  assert.equal(script.includes('Start-Sleep -Milliseconds'), true);
  assert.equal(script.includes('[uint32]0'), true);
  assert.equal(script.includes('exit 2'), true);
  assert.equal(script.includes('exit 3'), true);
  assert.equal(script.includes('Write-Error'), true);
  assert.equal(hasPidVariable(script), false, 'never $pid (automatic variable)');
  assert.equal(script.includes("$ErrorActionPreference='Stop'"), true);
  assert.equal(script.includes('SilentlyContinue'), false);
  assert.equal(script.includes('ControlType]::Edit'), false, 'no conversation scraping');
  assert.equal(script.includes('ControlType]::Document'), false);
  assert.equal(script.includes('TextPattern'), false);
  assert.equal(script.includes('ValuePattern'), false);
  assert.equal(script.includes('ConvertTo-Json'), false);
  assert.equal(script.includes('MatchSubstring'), false, 'no invented managed flag');
  assert.equal(script.includes('PropertyConditionFlags'), false);
  assert.equal(script.includes('WindowText'), false);
  assert.equal(script.includes('.Title'), false);
  assert.equal(script.includes('$watchExpected=23764'), true, 'expected PID is a parameter');
  assert.equal(script.includes('2427202'), false, 'no hardcoded HWND');
  assert.equal(script.includes('3.6556'), false, 'no hardcoded version');
  assert.equal(script.includes('pzs8sxrjxfjjc'), false, 'no hardcoded package');
  assert.equal(script.includes('Program Files'), false, 'no hardcoded install path');

  const other = buildClaudeDesktopModelSamplerScript(11111, 4242, 500);
  assert.equal(other.includes('$watchExpected=11111'), true);
  assert.equal(other.includes('23764'), false, 'PID is parameterized, never hardcoded');
});

test('Desktop sampler script rejects invalid PIDs and clamps cadence', () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.throws(
      () => buildClaudeDesktopModelSamplerScript(bad, 4242, 500),
      /Invalid expected PID/,
      `expected ${String(bad)} must reject`
    );
    assert.throws(
      () => buildClaudeDesktopModelSamplerScript(23764, bad, 500),
      /Invalid parent PID/,
      `parent ${String(bad)} must reject`
    );
  }

  for (const bad of [NaN, 0, -10]) {
    const script = buildClaudeDesktopModelSamplerScript(23764, 4242, bad);
    assert.equal(script.includes('$watchSample=500'), true, `sample ${String(bad)} falls back to 500ms`);
  }
  assert.equal(buildClaudeDesktopModelSamplerScript(23764, 4242, 10).includes('$watchSample=250'), true);
  assert.equal(buildClaudeDesktopModelSamplerScript(23764, 4242, 5000).includes('$watchSample=2000'), true);
});

test('Desktop watcher startup rejects invalid PIDs visibly without spawning', () => {
  resetClaudeDesktopModelWatcherForTests();
  try {
    const badExpected = startClaudeDesktopModelWatcher(() => {}, () => {}, { expectedPid: 0 });
    assert.equal(badExpected, null, 'invalid expected PID must not spawn');
    assert.equal((getClaudeDesktopModelWatcherStats().lastError || '').toLowerCase().includes('invalid expected pid'), true);
    const badParent = startClaudeDesktopModelWatcher(() => {}, () => {}, { expectedPid: 23764, parentPid: 0 });
    assert.equal(badParent, null, 'invalid parent must not spawn');
    assert.equal((getClaudeDesktopModelWatcherStats().lastError || '').toLowerCase().includes('invalid parent pid'), true);
    assert.equal(isClaudeDesktopModelWatcherHealthy(), false);
  } finally {
    resetClaudeDesktopModelWatcherForTests();
  }
});

test('Desktop helper cleans up on normal stop without orphaning', { skip: process.platform !== 'win32' }, async (t) => {
  resetClaudeDesktopModelWatcherForTests();
  t.after(() => resetClaudeDesktopModelWatcherForTests());

  const handle = startClaudeDesktopModelWatcher(() => {}, undefined, { expectedPid: process.pid });
  assert.ok(handle, 'expected the sampler to start on Windows');
  assert.equal(isClaudeDesktopModelWatcherHealthy(), true);

  const stats = getClaudeDesktopModelWatcherStats();
  assert.ok(stats.pid && stats.pid > 0);
  assert.ok(isPidAlive(stats.pid), 'sampler child must be alive after start');
  assert.equal(stats.expectedPid, process.pid);

  const second = startClaudeDesktopModelWatcher(() => {}, undefined, { expectedPid: process.pid });
  assert.equal(second && second.pid, handle.pid, 'same PID reuses the singleton');
  assert.equal(getClaudeDesktopModelWatcherStats().restarts, 0);

  stopClaudeDesktopModelWatcher();
  const exited = await waitForCondition(() => !isPidAlive(stats.pid), 5000);
  assert.equal(exited, true, 'sampler child must exit after stop (no orphan)');
  assert.equal(isClaudeDesktopModelWatcherHealthy(), false);
});

test('Desktop helper self-exits when the parent PID is gone', { skip: process.platform !== 'win32' }, async () => {
  const fakeParent = 999999;
  assert.equal(isPidAlive(fakeParent), false, 'fake parent PID must not exist for this test');

  const script = buildClaudeDesktopModelSamplerScript(process.pid, fakeParent, 500);
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  });
  assert.ok(child.pid);

  try {
    if (child.stdin) {
      child.stdin.on('error', () => {});
    }
    const exited = await waitForCondition(() => child.exitCode !== null, 8000, 100);
    assert.equal(exited, true, 'sampler must self-exit on parent death');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    try {
      if (child.stdin) {
        child.stdin.destroy();
      }
    } catch (_) {}
  }

  assert.equal(isPidAlive(child.pid), false, 'no orphan after parent-death exit');
});

test('Desktop helper self-exits on stdin EOF', { skip: process.platform !== 'win32' }, async () => {
  const script = buildClaudeDesktopModelSamplerScript(process.pid, process.pid, 500);
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  });
  assert.ok(child.pid);

  try {
    if (child.stdin) {
      child.stdin.on('error', () => {});
    }
    try {
      if (child.stdin) {
        child.stdin.end();
      }
    } catch (_) {}

    const exited = await waitForCondition(() => child.exitCode !== null, 8000, 100);
    assert.equal(exited, true, 'sampler must self-exit on stdin EOF');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    try {
      if (child.stdin) {
        child.stdin.destroy();
      }
    } catch (_) {}
  }

  assert.equal(isPidAlive(child.pid), false, 'no orphan after stdin-EOF exit');
});

test('grok ignores cache/config guesses but keeps an explicit bound hook model', async (t) => {
  const { env } = createTestEnvironment(t);
  const grokHooksDir = env.DISCORD_CODING_STATUS_GROK_HOOKS_DIR;
  const grokDir = path.dirname(grokHooksDir);
  fs.mkdirSync(grokDir, { recursive: true });
  fs.writeFileSync(
    path.join(grokDir, 'models_cache.json'),
    JSON.stringify({ models: { 'zzz-first': { info: { id: 'zzz-first', name: 'Wrong First Cache', reasoning_effort: 'low' } } } })
  );
  fs.writeFileSync(path.join(grokDir, 'config.toml'), 'model = "config-default-wrong" fork_secondary_model = "secondary-wrong"');

  await runCli(
    ['grok-hook', '--event', 'SessionStart'],
    env,
    15000,
    JSON.stringify({ hookEventName: 'session_start', sessionId: 'grok-unbound', cwd: process.cwd() })
  );
  let state = JSON.parse((await runCli(['state'], env)).stdout);
  assert.equal(state.sessions['grok-unbound'].model, undefined, 'cache/config guesses must not publish');
  assert.equal(state.sessions['grok-unbound'].effort, undefined);

  await runCli(
    ['grok-hook', '--event', 'UserPromptSubmit', '--model', 'grok-flag-model'],
    env,
    15000,
    JSON.stringify({ hookEventName: 'user_prompt_submit', sessionId: 'grok-flag', cwd: process.cwd() })
  );
  state = JSON.parse((await runCli(['state'], env)).stdout);
  assert.equal(state.sessions['grok-flag'].model, 'grok-flag-model', 'explicit --model flag remains');

  await runCli(
    ['grok-hook', '--event', 'UserPromptSubmit'],
    env,
    15000,
    JSON.stringify({ hookEventName: 'user_prompt_submit', sessionId: 'grok-input', cwd: process.cwd(), model: 'grok-input-model' })
  );
  state = JSON.parse((await runCli(['state'], env)).stdout);
  assert.equal(state.sessions['grok-input'].model, 'grok-input-model', 'explicit hook input model remains');
});
