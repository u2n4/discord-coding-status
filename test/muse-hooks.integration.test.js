'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Isolate Muse settings before loading the module so in-process tests never
// touch the real ~/.config/muse/settings.json. Subprocess tests get a
// per-test override through createTestEnvironment instead.
const MUSE_SETTINGS_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-settings-test-'));
process.env.DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE = path.join(MUSE_SETTINGS_SANDBOX, 'settings.json');

const {
  MUSE_HOOK_EVENTS,
  MUSE_MANAGED_HOOK_MARKER,
  MUSE_SETTINGS_FILE,
  MUSE_SETTINGS_SCHEMA_VERSION,
  findOwningMuseProcess,
  getManagedMuseHookStatus,
  installManagedMuseHooks,
  museHookCommand,
  museHookCommandWindows,
  normalizeMuseHookModel,
  readMuseSettings,
  removeManagedMuseHooks,
  resolveOwningMuseFromChain,
  statusFromMuseHookEvent,
  writeMuseSettings
} = require('../dist/muse-hooks');
delete process.env.DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE;
const {
  applyMuseDisplayResolution,
  getRememberedMuseDisplaySession,
  isMuseHookBindingLive,
  rememberMuseDisplaySession,
  resetRememberedMuseDisplaySessionForTests,
  resolveMuseDisplaySession
} = require('../dist/core/selection/muse-instance');
const { musePidForForegroundProcess } = require('../dist/adapters/system/foreground');
const { detectedHookInstallers, findHookInstaller } = require('../dist/hook-installers');
const { shouldInstallHooksFor } = require('../dist/commands/setup/policy');
const { toolProviders } = require('../dist/providers/registry');

const {
  createTestEnvironment,
  readRpcEvents,
  runCli,
  startDaemon,
  waitFor
} = require('./helpers');

test.after(async () => {
  fs.rmSync(MUSE_SETTINGS_SANDBOX, { recursive: true, force: true });
});

function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function seedUserSettings() {
  return {
    theme: 'dark',
    model: 'user-default-model',
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'user-session-hook' }] }
      ],
      CustomEvent: [
        { hooks: [{ type: 'command', command: 'user-custom-hook' }] }
      ]
    }
  };
}

function managedGroupsFor(settings, eventName) {
  const groups = settings.hooks[eventName];
  assert.ok(Array.isArray(groups), `expected groups for ${eventName}`);
  return groups
    .flatMap((group) => group.hooks)
    .filter((hook) => hook.type === 'command' && hook.command.includes(MUSE_MANAGED_HOOK_MARKER));
}

test('muse settings override resolves to the sandbox file, never the real config', () => {
  assert.equal(MUSE_SETTINGS_FILE, path.join(MUSE_SETTINGS_SANDBOX, 'settings.json'));
  assert.equal(MUSE_SETTINGS_SCHEMA_VERSION, 1);
  assert.deepEqual([...MUSE_HOOK_EVENTS], [
    'SessionStart',
    'UserPromptSubmit',
    'PreLLMCall',
    'PostLLMCall',
    'SessionEnd'
  ]);
});

test('muse install merges one managed group per documented event and preserves user content', () => {
  const result = installManagedMuseHooks(seedUserSettings(), '/path/to/cli.js');
  assert.equal(result.installed, MUSE_HOOK_EVENTS.length);
  assert.equal(result.removed, 0);

  const settings = result.settings;
  assert.equal(settings.schema_version, 1);
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.model, 'user-default-model');
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...MUSE_HOOK_EVENTS, 'CustomEvent'].sort());

  // The user's own SessionStart group and custom event survive untouched.
  const sessionStart = settings.hooks.SessionStart;
  assert.equal(sessionStart.length, 2);
  assert.equal(sessionStart[0].hooks[0].command, 'user-session-hook');
  assert.equal(settings.hooks.CustomEvent[0].hooks[0].command, 'user-custom-hook');

  for (const eventName of MUSE_HOOK_EVENTS) {
    const managed = managedGroupsFor(settings, eventName);
    assert.equal(managed.length, 1, `exactly one managed hook for ${eventName}`);
    const hook = managed[0];
    assert.match(hook.command, /muse-hook/);
    assert.ok(hook.command.includes(eventName), `command references ${eventName}`);
    assert.match(hook.commandWindows, /muse-hook/);
    assert.ok(hook.commandWindows.includes(eventName), `commandWindows references ${eventName}`);
    assert.ok(hook.commandWindows.includes(MUSE_MANAGED_HOOK_MARKER), 'windows form carries the marker');
    assert.equal(hook.timeout, 5);
    assert.equal(hook.async, false);
  }

  const status = getManagedMuseHookStatus(settings);
  assert.equal(status.installed, true);
  assert.equal(status.managedCount, MUSE_HOOK_EVENTS.length);
  assert.deepEqual(status.missingEvents, []);
  assert.deepEqual(status.duplicateEvents, []);
  assert.deepEqual(status.unexpectedEvents, []);
});

test('muse install preserves an existing schema_version instead of forcing 1', () => {
  const seeded = { ...seedUserSettings(), schema_version: 7 };
  const result = installManagedMuseHooks(seeded, '/path/to/cli.js');
  assert.equal(result.settings.schema_version, 7);
});

test('muse install is idempotent: a second install replaces, never duplicates', () => {
  const first = installManagedMuseHooks(seedUserSettings(), '/path/to/cli.js');
  const second = installManagedMuseHooks(first.settings, '/path/to/cli.js');
  assert.equal(second.installed, MUSE_HOOK_EVENTS.length);
  assert.equal(second.removed, MUSE_HOOK_EVENTS.length);
  assert.deepEqual(second.settings, first.settings);

  const status = getManagedMuseHookStatus(second.settings);
  assert.equal(status.installed, true);
  assert.equal(status.managedCount, MUSE_HOOK_EVENTS.length);
});

test('muse uninstall removes only managed hooks and keeps user content', () => {
  const installed = installManagedMuseHooks(seedUserSettings(), '/path/to/cli.js').settings;
  const removed = removeManagedMuseHooks(installed);
  assert.equal(removed.removed, MUSE_HOOK_EVENTS.length);

  const settings = removed.settings;
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.schema_version, 1);
  assert.deepEqual(settings.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'user-session-hook' }] }]);
  assert.equal(settings.hooks.CustomEvent[0].hooks[0].command, 'user-custom-hook');
  assert.equal(settings.hooks.PreLLMCall, undefined, 'events with only managed groups are pruned');

  const status = getManagedMuseHookStatus(settings);
  assert.equal(status.installed, false);
  assert.equal(status.managedCount, 0);
  assert.deepEqual(status.missingEvents, [...MUSE_HOOK_EVENTS]);
});

test('muse status reports missing, duplicate, and unexpected managed events', () => {
  const empty = getManagedMuseHookStatus({});
  assert.equal(empty.installed, false);
  assert.deepEqual(empty.missingEvents, [...MUSE_HOOK_EVENTS]);

  const installed = installManagedMuseHooks({}, '/path/to/cli.js').settings;
  const duplicated = structuredClone(installed);
  duplicated.hooks.SessionStart.push(structuredClone(duplicated.hooks.SessionStart[0]));
  const dupStatus = getManagedMuseHookStatus(duplicated);
  assert.equal(dupStatus.installed, false);
  assert.deepEqual(dupStatus.duplicateEvents, ['SessionStart']);

  const unexpected = structuredClone(installed);
  unexpected.hooks.SomeFutureEvent = structuredClone(installed.hooks.SessionStart);
  const unexpectedStatus = getManagedMuseHookStatus(unexpected);
  assert.equal(unexpectedStatus.installed, false);
  assert.deepEqual(unexpectedStatus.unexpectedEvents, ['SomeFutureEvent']);
});

test('muse settings write UTF-8 without BOM, atomically, with a backup', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-settings-write-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');

  writeMuseSettings(file, { schema_version: 1, hooks: {} });
  const raw = fs.readFileSync(file);
  assert.ok(!raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'no UTF-8 BOM');
  assert.equal(raw[0], 0x7b, 'file starts with {');
  assert.deepEqual(JSON.parse(raw.toString('utf8')), { schema_version: 1, hooks: {} });
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  writeMuseSettings(file, { schema_version: 1, hooks: {}, theme: 'dark' });
  assert.ok(fs.existsSync(`${file}.bak`), 'previous file kept as .bak');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { schema_version: 1, hooks: {} });
  assert.equal(fs.readdirSync(directory).filter((name) => name.includes('.tmp-')).length, 0, 'no temp left behind');
});

test('muse settings read fails closed on corrupt JSON instead of crashing', (t) => {
  fs.writeFileSync(MUSE_SETTINGS_FILE, '{ corrupt json {{{');
  t.after(() => fs.rmSync(MUSE_SETTINGS_FILE, { force: true }));
  assert.deepEqual(readMuseSettings(), {});
});

test('muse hook commands are cmd-compatible on Windows and posix-quoted elsewhere', () => {
  // Proven receiver ancestry is node <- cmd <- muse-bin: Muse dispatches via
  // cmd.exe, so the Windows form must be plain double-quoted args, never a
  // PowerShell call operator (which cmd cannot parse).
  const windowsCommand = withPlatform('win32', () => museHookCommand('C:\\app\\cli.js', 'PreLLMCall'));
  assert.ok(windowsCommand.startsWith('"'), 'windows command starts with a quoted path');
  assert.ok(windowsCommand.includes('"C:\\app\\cli.js" muse-hook --event PreLLMCall'), windowsCommand);
  assert.ok(windowsCommand.includes(MUSE_MANAGED_HOOK_MARKER), 'owner marker survives quoting');
  assert.equal(windowsCommand.startsWith('&'), false, 'no powershell call operator under cmd');
  assert.doesNotMatch(windowsCommand, /& '/);

  const windowsDirect = museHookCommandWindows('C:\\app\\cli.js', 'SessionEnd');
  assert.ok(windowsDirect.includes('"C:\\app\\cli.js" muse-hook --event SessionEnd'), windowsDirect);
  assert.ok(windowsDirect.includes(MUSE_MANAGED_HOOK_MARKER));

  const posixCommand = withPlatform('linux', () => museHookCommand('/app/cli.js', 'PreLLMCall'));
  assert.equal(posixCommand.startsWith('&'), false, 'posix command is not a powershell call');
  assert.ok(posixCommand.includes("'/app/cli.js' muse-hook --event 'PreLLMCall'"), posixCommand);
  assert.ok(posixCommand.includes(MUSE_MANAGED_HOOK_MARKER));
});

test('muse hook event statuses map lifecycle without inventing activity', () => {
  assert.equal(statusFromMuseHookEvent('SessionStart'), 'running');
  assert.equal(statusFromMuseHookEvent('UserPromptSubmit'), 'running');
  assert.equal(statusFromMuseHookEvent('PreLLMCall'), 'running');
  assert.equal(statusFromMuseHookEvent('PostLLMCall'), 'running');
  assert.equal(statusFromMuseHookEvent('SessionEnd'), 'stopped');
  assert.equal(statusFromMuseHookEvent('session_end'), 'stopped');
  assert.equal(statusFromMuseHookEvent('SomethingElse'), 'active');
});

test('muse stdin models accept the authoritative label and reject proven non-models', () => {
  assert.equal(normalizeMuseHookModel('muse-spark-1.3'), 'muse-spark-1.3');
  assert.equal(normalizeMuseHookModel('  muse-spark-1.3  '), 'muse-spark-1.3');
  assert.equal(normalizeMuseHookModel('unknown'), null, 'offline echo placeholder is not a model');
  assert.equal(normalizeMuseHookModel('Unknown'), null);
  assert.equal(normalizeMuseHookModel('same-as-main'), null, 'routing alias is not a model');
  assert.equal(normalizeMuseHookModel(''), null);
  assert.equal(normalizeMuseHookModel(null), null);
  assert.equal(normalizeMuseHookModel(42), null);
});

const TUI_SESSION_ID = '01a17ef1-2807-75a3-9f1d-2f7069a8f144';

function museStdin(overrides = {}) {
  return JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: TUI_SESSION_ID,
    model: 'muse-spark-1.3',
    transcript_path: null,
    ...overrides
  });
}

async function readState(env) {
  return JSON.parse((await runCli(['state'], env)).stdout);
}

test('muse SessionStart with real-input shape records the exact model and no junk', async (t) => {
  const { env } = createTestEnvironment(t);

  // Exercise muse-hook through the CLI (never in-process): the session
  // builder reads piped stdin, which blocks forever under node --test
  // because the runner holds the pipe open without EOF.
  await runCli(
    ['muse-hook', '--event', 'SessionStart'],
    env,
    15000,
    museStdin({
      prompt: 'SECRET-PROMPT-MUST-NOT-LAND',
      messages: [{ role: 'user', content: 'SECRET-CHAT-MUST-NOT-LAND' }],
      tool_input: { command: 'SECRET-TOOL-MUST-NOT-LAND' }
    })
  );

  const state = await readState(env);
  const session = state.sessions[TUI_SESSION_ID];
  assert.ok(session, 'expected the native session to be recorded');
  assert.equal(session.tool, 'muse');
  assert.equal(session.surface, 'cli');
  assert.equal(session.status, 'running');
  assert.equal(session.model, 'muse-spark-1.3');
  assert.ok(path.isAbsolute(session.cwd), 'cwd resolves absolute');
  assert.ok(Number.isFinite(session.updated_at) && session.updated_at > 0);

  const stored = JSON.stringify(session);
  assert.doesNotMatch(stored, /SECRET-PROMPT-MUST-NOT-LAND/, 'prompts never land in state');
  assert.doesNotMatch(stored, /SECRET-CHAT-MUST-NOT-LAND/, 'chat never lands in state');
  assert.doesNotMatch(stored, /SECRET-TOOL-MUST-NOT-LAND/, 'tool data never lands in state');
  assert.equal(session.transcript_path, undefined, 'transcript paths are not consumed');
  assert.equal(session.activity, undefined, 'no activity is invented');
  assert.equal(session.effort, undefined, 'effort is never shown or stored');

  // Binding is environment-dependent (a suite run under `muse exec` would
  // legitimately bind), so only the shape is asserted here; the binder logic
  // itself is covered by injected-chain units below.
  if (session.musePid !== undefined) {
    assert.ok(Number.isInteger(session.musePid) && session.musePid > 0);
    assert.ok(Number.isFinite(session.museCreatedAtMs) && session.museCreatedAtMs > 0);
  } else {
    assert.equal(session.museCreatedAtMs, undefined);
  }
});

test('muse PreLLMCall updates the same session model in place', async (t) => {
  const { env } = createTestEnvironment(t);

  await runCli(['muse-hook', '--event', 'SessionStart'], env, 15000, museStdin({ model: 'muse-spark-1.2' }));
  await runCli(
    ['muse-hook', '--event', 'PreLLMCall'],
    env,
    15000,
    museStdin({ hook_event_name: 'PreLLMCall', model: 'muse-spark-1.3' })
  );

  const state = await readState(env);
  assert.deepEqual(Object.keys(state.sessions), [TUI_SESSION_ID], 'model event reuses the session id');
  assert.equal(state.sessions[TUI_SESSION_ID].model, 'muse-spark-1.3');
  assert.equal(state.sessions[TUI_SESSION_ID].status, 'running');
});

test('muse placeholder, alias, and empty models record the session app-only', async (t) => {
  const { env } = createTestEnvironment(t);

  const cases = [
    ['muse-unknown-model', 'unknown'],
    ['muse-alias-model', 'same-as-main'],
    ['muse-empty-model', '']
  ];
  for (const [sessionId, model] of cases) {
    await runCli(
      ['muse-hook', '--event', 'SessionStart'],
      env,
      15000,
      museStdin({ session_id: sessionId, model })
    );
  }

  const state = await readState(env);
  for (const [sessionId] of cases) {
    assert.ok(state.sessions[sessionId], `${sessionId} is recorded`);
    assert.equal(state.sessions[sessionId].model, undefined, `${sessionId} stays app-only`);
  }
});

test('muse SessionEnd clears the session and explicit --model wins over stdin', async (t) => {
  const { env } = createTestEnvironment(t);

  await runCli(
    ['muse-hook', '--event', 'SessionStart', '--model', 'muse-explicit-1.0'],
    env,
    15000,
    museStdin({ model: 'muse-spark-1.3' })
  );
  let state = await readState(env);
  assert.equal(state.sessions[TUI_SESSION_ID].model, 'muse-explicit-1.0', 'explicit --model wins');

  await runCli(
    ['muse-hook', '--event', 'SessionEnd'],
    env,
    15000,
    museStdin({ hook_event_name: 'SessionEnd' })
  );
  state = await readState(env);
  assert.equal(state.sessions[TUI_SESSION_ID], undefined, 'terminal event clears the session');
});

test('muse-hook with missing session id and invalid stdin still exits 0', async (t) => {
  const { env } = createTestEnvironment(t);

  await runCli(['muse-hook', '--event', 'SessionStart'], env, 15000, JSON.stringify({}));
  let state = await readState(env);
  const fallbackIds = Object.keys(state.sessions).filter((id) => id.startsWith('muse:cli:'));
  assert.equal(fallbackIds.length, 1, 'missing session id falls back to a muse-namespaced id');
  assert.match(fallbackIds[0], /^muse:cli:.+:\d+$/);

  // Invalid stdin must never cause a non-zero exit, so runCli resolving proves exit 0.
  await runCli(['muse-hook', '--event', 'UserPromptSubmit'], env, 15000, '{ not valid json');
  state = await readState(env);
  assert.ok(Object.keys(state.sessions).length >= 1, 'receiver survives invalid stdin');
});

// Verified TUI ancestry shape (2026-10-27 probe): receiver <- cmd 8080 <-
// muse-bin 44200 <- powershell 33576, with exact live creation times.
const PROOF_NOW_MS = Date.parse('2026-10-27T22:58:18.000+03:00');

function ancestorEntry(pid, ppid, name, exe, created) {
  return { pid, ppid, name, exe, created };
}

const PROOF_TUI_CHAIN = [
  ancestorEntry(8080, 44200, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe', '2026-10-27T22:58:17.4195550+03:00'),
  ancestorEntry(44200, 33576, 'muse-bin-1.4.14-R7309.1.exe', 'C:\\Users\\aliha\\AppData\\Local\\Programs\\muse\\muse-bin-1.4.14-R7309.1.exe', '2026-10-27T22:58:15.9054850+03:00'),
  ancestorEntry(33576, 38860, 'powershell.exe', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '2026-10-27T22:58:15.3448410+03:00')
];

test('ancestor binder resolves the owning muse binary from the proof TUI chain', () => {
  const proof = resolveOwningMuseFromChain(PROOF_TUI_CHAIN, PROOF_NOW_MS);
  assert.ok(proof);
  assert.equal(proof.musePid, 44200);
  assert.equal(proof.museCreatedAtMs, Date.parse('2026-10-27T22:58:15.9054850+03:00'));
});

test('ancestor binder resolves through wrappers and the plain muse launcher', () => {
  const execChain = [
    ancestorEntry(46752, 47040, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe', '2026-10-27T22:51:30.1101920+03:00'),
    ancestorEntry(47040, 42904, 'muse-bin-1.4.14-R7309.1.exe', 'C:\\Users\\aliha\\AppData\\Local\\Programs\\muse\\muse-bin-1.4.14-R7309.1.exe', '2026-10-27T22:51:28.7704280+03:00')
  ];
  const execProof = resolveOwningMuseFromChain(execChain, Date.parse('2026-10-27T22:51:31.000+03:00'));
  assert.ok(execProof);
  assert.equal(execProof.musePid, 47040);

  const launcherChain = [
    ancestorEntry(111, 222, 'powershell.exe', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '2026-10-27T22:00:02.000+03:00'),
    ancestorEntry(222, 333, 'muse.exe', 'C:\\Users\\aliha\\AppData\\Local\\Programs\\muse\\muse.exe', '2026-10-27T22:00:01.000+03:00')
  ];
  const launcherProof = resolveOwningMuseFromChain(launcherChain, Date.parse('2026-10-27T22:00:03.000+03:00'));
  assert.ok(launcherProof);
  assert.equal(launcherProof.musePid, 222);

  // A null ExecutablePath (protected process) still binds via process name,
  // which is identity — never a command line.
  const nameless = [
    ancestorEntry(444, 555, 'muse-bin-1.4.14-R7309.1.exe', null, '2026-10-27T22:00:01.000+03:00')
  ];
  assert.equal(
    resolveOwningMuseFromChain(nameless, Date.parse('2026-10-27T22:00:03.000+03:00'))?.musePid,
    444
  );
});

test('ancestor binder stays unbound without a muse binary and rejects decoys', () => {
  const plain = [
    ancestorEntry(100, 200, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe', '2026-10-27T22:00:02.000+03:00'),
    ancestorEntry(200, 300, 'powershell.exe', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '2026-10-27T22:00:01.000+03:00'),
    ancestorEntry(300, 0, 'explorer.exe', 'C:\\WINDOWS\\Explorer.EXE', '2026-10-26T16:00:00.000+03:00')
  ];
  assert.equal(resolveOwningMuseFromChain(plain, Date.parse('2026-10-27T22:00:03.000+03:00')), null);
  assert.equal(resolveOwningMuseFromChain([], Date.now()), null);
  assert.equal(resolveOwningMuseFromChain(null, Date.now()), null);

  for (const decoy of ['amuse.exe', 'museum.exe', 'my-muse.exe', 'muse.md', 'libmuse-bin-x']) {
    const chain = [
      ancestorEntry(100, 200, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe', '2026-10-27T22:00:02.000+03:00'),
      ancestorEntry(200, 300, decoy, `C:\\Tools\\${decoy}`, '2026-10-27T22:00:01.000+03:00')
    ];
    assert.equal(
      resolveOwningMuseFromChain(chain, Date.parse('2026-10-27T22:00:03.000+03:00')),
      null,
      `${decoy} must never bind`
    );
  }
});

test('ancestor binder truncates reused-PID tails and terminates on cycles', () => {
  // Proof invalid tail shape: an entry newer than its child is PID reuse, so
  // everything after it is untrusted — including a muse binary down there.
  const reusedTail = [
    ancestorEntry(8080, 44200, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe', '2026-10-27T22:58:17.4195550+03:00'),
    ancestorEntry(33576, 14500, 'powershell.exe', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '2026-10-27T22:58:15.3448410+03:00'),
    ancestorEntry(14500, 37028, 'conhost.exe', 'C:\\WINDOWS\\system32\\conhost.exe', '2026-10-27T22:58:17.5237070+03:00'),
    ancestorEntry(99999, 1, 'muse-bin-9.9.exe', 'C:\\fake\\muse-bin-9.9.exe', '2026-10-27T22:58:10.000+03:00')
  ];
  assert.equal(resolveOwningMuseFromChain(reusedTail, PROOF_NOW_MS), null, 'muse past the reuse point is untrusted');

  // A muse binary in the still-valid prefix still binds despite later garbage.
  const prefixPlusGarbage = [
    ...PROOF_TUI_CHAIN,
    ancestorEntry(14500, 37028, 'conhost.exe', 'C:\\WINDOWS\\system32\\conhost.exe', '2026-10-27T22:58:17.5237070+03:00')
  ];
  assert.equal(resolveOwningMuseFromChain(prefixPlusGarbage, PROOF_NOW_MS)?.musePid, 44200);

  const cycle = [
    ancestorEntry(100, 200, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe', '2026-10-27T22:00:02.000+03:00'),
    ancestorEntry(200, 100, 'powershell.exe', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '2026-10-27T22:00:01.000+03:00'),
    ancestorEntry(100, 200, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe', '2026-10-27T22:00:00.000+03:00')
  ];
  assert.equal(resolveOwningMuseFromChain(cycle, Date.parse('2026-10-27T22:00:03.000+03:00')), null);
});

test('findOwningMuseProcess honors injected queries and never throws', () => {
  const proof = findOwningMuseProcess({
    ppid: 8080,
    nowMs: PROOF_NOW_MS,
    queryChain: (ppid) => {
      assert.equal(ppid, 8080);
      return PROOF_TUI_CHAIN;
    }
  });
  assert.ok(proof);
  assert.equal(proof.musePid, 44200);

  assert.equal(findOwningMuseProcess({ ppid: 0, queryChain: () => PROOF_TUI_CHAIN }), null);
  assert.equal(findOwningMuseProcess({ ppid: -5, queryChain: () => PROOF_TUI_CHAIN }), null);
  assert.equal(findOwningMuseProcess({
    ppid: 8080,
    queryChain: () => { throw new Error('cim unavailable'); }
  }), null);
  assert.equal(findOwningMuseProcess({ ppid: 8080, queryChain: () => null }), null);
});

test('binding liveness requires the exact creation identity of a live muse binary', () => {
  const createdAtMs = Date.parse('2026-10-27T22:58:15.905+03:00');
  const binding = { pid: 44200, createdAtMs };
  const live = [
    { pid: 8080, line: 'cmd', raw: 'cmd', executablePath: 'C:\\WINDOWS\\system32\\cmd.exe', createdAtMs: createdAtMs + 2000 },
    { pid: 44200, line: 'muse', raw: 'muse', executablePath: 'C:\\Users\\aliha\\AppData\\Local\\Programs\\muse\\muse-bin-1.4.14-R7309.1.exe', createdAtMs }
  ];

  assert.equal(isMuseHookBindingLive(binding, live), true);
  assert.equal(isMuseHookBindingLive({ pid: 44200, createdAtMs: createdAtMs + 1 }, live), false, 'PID reuse fails closed');
  assert.equal(isMuseHookBindingLive({ pid: 99999, createdAtMs }, live), false, 'ended process fails closed');
  assert.equal(
    isMuseHookBindingLive(binding, [{ pid: 44200, line: 'muse', raw: 'muse', executablePath: 'C:\\muse\\muse.exe' }]),
    false,
    'missing creation time cannot verify'
  );
  assert.equal(
    isMuseHookBindingLive(binding, [{ pid: 44200, line: 'muse', raw: 'muse', executablePath: 'C:\\Tools\\amuse.exe', createdAtMs }]),
    false,
    'non-muse binary at the PID fails closed'
  );
  assert.equal(
    isMuseHookBindingLive(binding, [{ pid: 44200, line: 'muse', raw: 'muse', createdAtMs }]),
    false,
    'missing executable path fails closed instead of guessing from text'
  );
});

function foregroundProcess(pid, exe, ppid) {
  const line = `${exe} --foreground-test`;
  return { pid, ppid, line, raw: line, executablePath: exe, commandLine: line };
}

const CONHOST = 'C:\\WINDOWS\\system32\\conhost.exe';
const POWERSHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const MUSE_BIN = 'C:\\Users\\aliha\\AppData\\Local\\Programs\\muse\\muse-bin-1.4.14-R7309.1.exe';
const CODEX_BIN = 'C:\\Users\\aliha\\AppData\\Local\\OpenAI\\Codex\\bin\\1\\codex.exe';

test('dedicated console resolves its single muse descendant, and only it', () => {
  const tree = [
    foregroundProcess(30856, CONHOST, 1),
    foregroundProcess(33576, POWERSHELL, 30856),
    foregroundProcess(44200, MUSE_BIN, 33576)
  ];
  assert.equal(musePidForForegroundProcess(30856, tree), 44200);
  assert.equal(musePidForForegroundProcess(33576, tree), 44200);
  assert.equal(musePidForForegroundProcess(44200, tree), 44200, 'a muse-owned window binds itself');
});

test('shared terminal panes and unknown hosts fail closed without newest-descendant guesses', () => {
  const panes = [
    foregroundProcess(100, CONHOST, 1),
    foregroundProcess(101, POWERSHELL, 100),
    foregroundProcess(102, MUSE_BIN, 101),
    foregroundProcess(103, MUSE_BIN, 101)
  ];
  assert.equal(musePidForForegroundProcess(100, panes), null, 'two muse siblings are ambiguous');

  const siblings = [
    foregroundProcess(100, CONHOST, 1),
    foregroundProcess(101, MUSE_BIN, 100),
    foregroundProcess(104, 'C:\\WINDOWS\\system32\\cmd.exe', 100),
    foregroundProcess(105, MUSE_BIN, 104)
  ];
  assert.equal(musePidForForegroundProcess(100, siblings), null, 'cousin panes are ambiguous too');

  const noMuse = [
    foregroundProcess(100, CONHOST, 1),
    foregroundProcess(101, POWERSHELL, 100),
    foregroundProcess(106, CODEX_BIN, 101)
  ];
  assert.equal(musePidForForegroundProcess(100, noMuse), null, 'no muse under the console');
  assert.equal(musePidForForegroundProcess(999999, noMuse), null, 'unknown foreground pid');

  const deep = [
    foregroundProcess(200, CONHOST, 1),
    foregroundProcess(201, POWERSHELL, 200),
    foregroundProcess(202, 'C:\\WINDOWS\\system32\\cmd.exe', 201),
    foregroundProcess(203, POWERSHELL, 202),
    foregroundProcess(204, 'C:\\WINDOWS\\system32\\cmd.exe', 203),
    foregroundProcess(205, MUSE_BIN, 204)
  ];
  assert.equal(musePidForForegroundProcess(200, deep), null, 'depth 5 is beyond the bound');
  assert.equal(
    musePidForForegroundProcess(201, deep),
    205,
    'the same muse at depth 4 from an inner root still binds'
  );
});

const TUI_BINDING = { pid: 44200, createdAtMs: Date.parse('2026-10-27T22:58:15.905+03:00') };
const WORKER_BINDING = { pid: 47040, createdAtMs: Date.parse('2026-10-27T22:51:28.770+03:00') };

function museSession(id, model, updatedAt, binding) {
  const session = {
    tool: 'muse',
    surface: 'cli',
    status: 'running',
    session_id: id,
    cwd: os.tmpdir(),
    updated_at: updatedAt
  };
  if (model !== undefined) {
    session.model = model;
  }
  if (binding) {
    session.musePid = binding.pid;
    session.museCreatedAtMs = binding.createdAtMs;
  }
  return session;
}

function tuiAndWorker() {
  // The worker hook is NEWER: newest-hook-wins would steal the human TUI.
  const tui = museSession('tui-session', 'muse-spark-1.3', 1000, TUI_BINDING);
  const worker = museSession('worker-session', 'muse-spark-9.9-worker', 2000, WORKER_BINDING);
  return { tui, worker, sessions: [tui, worker] };
}

function resolveForeground(tui, worker, foregroundMusePid, rememberedSessionId = null, livePids = null) {
  const live = livePids || new Set([TUI_BINDING.pid, WORKER_BINDING.pid]);
  return resolveMuseDisplaySession({
    sessions: [tui, worker],
    isBindingLive: (binding) => live.has(binding.pid),
    foregroundMusePid,
    rememberedSessionId
  });
}

test('foreground instance wins over a newer background worker with a distinct model', (t) => {
  resetRememberedMuseDisplaySessionForTests();
  t.after(resetRememberedMuseDisplaySessionForTests);
  const { tui, worker } = tuiAndWorker();

  const resolution = resolveForeground(tui, worker, TUI_BINDING.pid);
  assert.equal(resolution.kind, 'session');
  assert.equal(resolution.session.session_id, 'tui-session');
  assert.equal(resolution.session.model, 'muse-spark-1.3');
  assert.equal(resolution.via, 'foreground');
  assert.deepEqual(resolution.liveSessionIds, ['tui-session', 'worker-session']);

  const workerFocus = resolveForeground(tui, worker, WORKER_BINDING.pid);
  assert.equal(workerFocus.session.session_id, 'worker-session');
  assert.equal(workerFocus.via, 'foreground');
});

test('A->Muse->Discord retains the same instance instead of the newest session', (t) => {
  resetRememberedMuseDisplaySessionForTests();
  t.after(resetRememberedMuseDisplaySessionForTests);
  const { tui, worker } = tuiAndWorker();
  const alive = ['tui-session', 'worker-session'];

  // Focus the TUI console: positive association is remembered.
  const focused = resolveForeground(tui, worker, TUI_BINDING.pid, getRememberedMuseDisplaySession());
  assert.equal(focused.session.session_id, 'tui-session');
  assert.equal(rememberMuseDisplaySession(focused.session.session_id, alive), 'tui-session');

  // Discord/null focus: the SAME instance is retained, not the newer worker.
  const retained = resolveForeground(tui, worker, null, getRememberedMuseDisplaySession());
  assert.equal(retained.kind, 'session');
  assert.equal(retained.session.session_id, 'tui-session');
  assert.equal(retained.session.model, 'muse-spark-1.3');
  assert.equal(retained.via, 'retained');
  assert.equal(rememberMuseDisplaySession(null, alive), 'tui-session');

  // Ambiguous shared panes also retain (never clear, never guess newest).
  const ambiguous = resolveForeground(tui, worker, null, getRememberedMuseDisplaySession());
  assert.equal(ambiguous.session.session_id, 'tui-session');
});

test('competition without foreground proof or memory stays app-only, never newest', (t) => {
  resetRememberedMuseDisplaySessionForTests();
  t.after(resetRememberedMuseDisplaySessionForTests);
  const { tui, worker } = tuiAndWorker();

  const resolution = resolveForeground(tui, worker, null, null);
  assert.equal(resolution.kind, 'app-only');
  assert.deepEqual(resolution.liveSessionIds, ['tui-session', 'worker-session']);
});

test('a lone session wins without foreground proof; dead sessions never display', (t) => {
  resetRememberedMuseDisplaySessionForTests();
  t.after(resetRememberedMuseDisplaySessionForTests);
  const { worker } = tuiAndWorker();

  const lone = resolveMuseDisplaySession({
    sessions: [worker],
    isBindingLive: () => true,
    foregroundMusePid: null,
    rememberedSessionId: null
  });
  assert.equal(lone.kind, 'session');
  assert.equal(lone.session.session_id, 'worker-session');
  assert.equal(lone.via, 'single');

  // One valid candidate among zombies still wins; all zombies stay app-only.
  const { tui } = tuiAndWorker();
  const mixed = resolveMuseDisplaySession({
    sessions: [tui, worker],
    isBindingLive: (binding) => binding.pid === WORKER_BINDING.pid,
    foregroundMusePid: null,
    rememberedSessionId: null
  });
  assert.equal(mixed.kind, 'session');
  assert.equal(mixed.session.session_id, 'worker-session');
  assert.deepEqual(mixed.liveSessionIds, ['worker-session']);

  const allDead = resolveMuseDisplaySession({
    sessions: [tui, worker],
    isBindingLive: () => false,
    foregroundMusePid: null,
    rememberedSessionId: null
  });
  assert.equal(allDead.kind, 'app-only');
  assert.deepEqual(allDead.liveSessionIds, []);

  assert.deepEqual(resolveMuseDisplaySession({
    sessions: [],
    isBindingLive: () => true,
    foregroundMusePid: null,
    rememberedSessionId: null
  }), { kind: 'none', liveSessionIds: [] });
});

test('a bound claimant contradicting the focused instance fails closed', (t) => {
  resetRememberedMuseDisplaySessionForTests();
  t.after(resetRememberedMuseDisplaySessionForTests);
  const { worker } = tuiAndWorker();

  // Foreground provably hosts TUI pid 44200, but the only claimant binds the
  // worker pid: the focused TUI is demonstrably not this session.
  const vetoed = resolveMuseDisplaySession({
    sessions: [worker],
    isBindingLive: () => true,
    foregroundMusePid: TUI_BINDING.pid,
    rememberedSessionId: null
  });
  assert.equal(vetoed.kind, 'app-only');

  // Multi-session with a focused-but-silent TUI: no claimant binds it.
  const { tui } = tuiAndWorker();
  const silent = resolveMuseDisplaySession({
    sessions: [tui, worker],
    isBindingLive: () => true,
    foregroundMusePid: 12345,
    rememberedSessionId: null
  });
  assert.equal(silent.kind, 'app-only');
});

test('manual unbound sessions keep explicit behavior without hijacking bound ones', (t) => {
  resetRememberedMuseDisplaySessionForTests();
  t.after(resetRememberedMuseDisplaySessionForTests);
  const manual = museSession('manual-session', 'muse-explicit-1.0', 1000);

  const lone = resolveMuseDisplaySession({
    sessions: [manual],
    isBindingLive: () => true,
    foregroundMusePid: TUI_BINDING.pid,
    rememberedSessionId: null
  });
  assert.equal(lone.kind, 'session');
  assert.equal(lone.session.model, 'muse-explicit-1.0');

  const { tui } = tuiAndWorker();
  const contested = resolveMuseDisplaySession({
    sessions: [manual, tui],
    isBindingLive: () => true,
    foregroundMusePid: null,
    rememberedSessionId: null
  });
  assert.equal(contested.kind, 'app-only', 'unprovable competition fails closed');
});

test('a retained id for a gone session clears instead of sticking', (t) => {
  resetRememberedMuseDisplaySessionForTests();
  t.after(resetRememberedMuseDisplaySessionForTests);
  const { worker } = tuiAndWorker();

  assert.equal(rememberMuseDisplaySession('tui-session', ['tui-session', 'worker-session']), 'tui-session');
  assert.equal(rememberMuseDisplaySession(null, ['worker-session']), null, 'gone session clears memory');
  assert.equal(getRememberedMuseDisplaySession(), null);

  const resolution = resolveMuseDisplaySession({
    sessions: [worker],
    isBindingLive: () => true,
    foregroundMusePid: null,
    rememberedSessionId: 'tui-session'
  });
  assert.equal(resolution.kind, 'session');
  assert.equal(resolution.session.session_id, 'worker-session');
  assert.equal(resolution.via, 'single');
});

test('instance override rewrites only the muse hook tool, before enrichment', (t) => {
  resetRememberedMuseDisplaySessionForTests();
  t.after(resetRememberedMuseDisplaySessionForTests);
  const { tui, worker } = tuiAndWorker();

  const museHook = {
    key: 'state:worker-session',
    family: 'muse',
    providerId: 'museCli',
    source: 'hook',
    details: 'Using Muse',
    state: 'Muse Code',
    sessionId: 'worker-session',
    model: 'muse-spark-9.9-worker',
    updatedAt: 2000
  };
  const museProcess = {
    key: 'museCli',
    family: 'muse',
    providerId: 'museCli',
    source: 'process',
    details: 'Using Muse',
    state: 'Muse Code'
  };
  const codexHook = {
    key: 'state:codex-session',
    family: 'codex',
    source: 'hook',
    details: 'Using Codex',
    state: 'Codex',
    sessionId: 'codex-session',
    model: 'gpt-5.6-sol',
    updatedAt: 1500
  };

  const won = applyMuseDisplayResolution(
    [codexHook, museHook, museProcess],
    { kind: 'session', session: tui, via: 'foreground', liveSessionIds: ['tui-session', 'worker-session'] }
  );
  assert.equal(won[0], codexHook, 'other families untouched');
  assert.equal(won[2], museProcess, 'process-source muse untouched');
  assert.deepEqual(won[1], {
    ...museHook,
    key: 'state:tui-session',
    sessionId: 'tui-session',
    model: 'muse-spark-1.3',
    updatedAt: 1000
  });

  const appOnly = applyMuseDisplayResolution([museHook], { kind: 'app-only', liveSessionIds: [] });
  assert.deepEqual(appOnly, [{ ...museHook, model: null }]);

  const none = applyMuseDisplayResolution([museHook], { kind: 'none', liveSessionIds: [] });
  assert.deepEqual(none, [museHook]);
});

test('muse model events update Discord fast on the same session; SessionEnd clears', async (t) => {
  // Muse ships no default Discord application ID, so the daemon test pins a
  // fake one; without it the family is correctly excluded from display.
  const { env, rpcLogFile } = createTestEnvironment(t, {
    DISCORD_CODING_STATUS_MUSE_CLIENT_ID: '123456789012345678'
  });
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  await runCli(
    ['muse-hook', '--event', 'SessionStart'],
    env,
    15000,
    museStdin({ model: 'muse-spark-1.2' })
  );
  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity' && event.activity.details === 'Model: muse-spark-1.2'
    ),
    'the SessionStart model to reach Discord RPC'
  );

  await runCli(
    ['muse-hook', '--event', 'PreLLMCall'],
    env,
    15000,
    museStdin({ hook_event_name: 'PreLLMCall', model: 'muse-spark-1.3' })
  );
  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity' && event.activity.details === 'Model: muse-spark-1.3'
    ),
    'the same-session model switch to reach Discord RPC without a new focus event'
  );

  await runCli(
    ['muse-hook', '--event', 'SessionEnd'],
    env,
    15000,
    museStdin({ hook_event_name: 'SessionEnd' })
  );
  await waitFor(
    () => readRpcEvents(rpcLogFile).find((event) => event.method === 'clearActivity'),
    'the terminal muse session to clear Discord RPC'
  );

  const state = await readState(env);
  assert.equal(state.sessions[TUI_SESSION_ID], undefined);
  assert.equal(daemon.output().stderr, '');
});

test('hooks setup muse preserves user settings and round-trips status/uninstall in isolation', async (t) => {
  const { env } = createTestEnvironment(t);
  const settingsFile = env.DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE;
  assert.ok(settingsFile.includes('muse-settings.json'), 'settings override points at the tmpdir file');

  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(seedUserSettings(), null, 2));

  await runCli(['hooks', 'setup', 'muse'], env, 30000);
  let onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(onDisk.theme, 'dark', 'user settings survive install');
  assert.equal(onDisk.schema_version, 1);
  assert.equal(onDisk.hooks.SessionStart[0].hooks[0].command, 'user-session-hook');
  assert.equal(getManagedMuseHookStatus(onDisk).managedCount, MUSE_HOOK_EVENTS.length);

  let status = JSON.parse((await runCli(['hooks', 'status', 'muse'], env)).stdout).harnesses;
  assert.equal(status.muse.installed, true);
  assert.equal(status.muse.target, settingsFile);
  assert.equal(status.muse.targetExists, true);

  await runCli(['hooks', 'setup', 'muse'], env, 30000);
  onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(
    getManagedMuseHookStatus(onDisk).managedCount,
    MUSE_HOOK_EVENTS.length,
    'second setup stays idempotent'
  );

  await runCli(['hooks', 'uninstall', 'muse'], env, 30000);
  onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(onDisk.theme, 'dark', 'user settings survive uninstall');
  assert.deepEqual(onDisk.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'user-session-hook' }] }]);
  assert.equal(onDisk.hooks.PreLLMCall, undefined);

  status = JSON.parse((await runCli(['hooks', 'status', 'muse'], env)).stdout).harnesses;
  assert.equal(status.muse.installed, false);
  assert.equal(status.muse.managedCount, 0);
});

test('muse settings override is forced under tmpdir on hostile input', (t) => {
  const hostile = process.platform === 'win32'
    ? 'C:\\Users\\real-user\\.config\\muse\\settings.json'
    : '/home/real-user/.config/muse/settings.json';
  const { directory, env } = createTestEnvironment(t, {
    DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE: hostile
  });

  assert.equal(env.DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE, path.join(directory, 'muse-settings.json'));
  assert.notEqual(env.DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE, hostile);
});

test('muse resolves by capability, label, provider id, and family; setup flags follow policy', () => {
  assert.equal(findHookInstaller('muse')?.capability, 'muse');
  assert.equal(findHookInstaller('Muse Code')?.capability, 'muse');
  assert.equal(findHookInstaller('museCli')?.capability, 'muse');

  const detections = [{ key: 'museCli', detected: true }];
  const detected = detectedHookInstallers(detections, undefined, undefined);
  assert.ok(detected.some((installer) => installer.capability === 'muse'));

  assert.equal(
    shouldInstallHooksFor('muse', { 'no-muse-hooks': true }, detections, toolProviders),
    false
  );
  assert.equal(
    shouldInstallHooksFor('muse', { 'muse-hooks': true }, [], toolProviders),
    true
  );
  assert.equal(
    shouldInstallHooksFor('muse', {}, detections, toolProviders),
    true,
    'detected muse installs by default'
  );
  assert.equal(shouldInstallHooksFor('muse', {}, [], toolProviders), false);
});
