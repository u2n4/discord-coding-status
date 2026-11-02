'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { antigravityHookCommand } = require('../dist/antigravity-hooks');
const { readMuseExecModelForProcess } = require('../dist/providers/muse/model');
const { createTestEnvironment, runCli } = require('./helpers');

function readState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('Grok PreToolUse ignores nested tool_input model, session id, and cwd', async (t) => {
  const { directory, env, stateFile } = createTestEnvironment(t);
  const elsewhere = path.join(directory, 'nested-elsewhere');

  await runCli(
    ['grok-hook', '--event', 'PreToolUse'],
    env,
    15000,
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'grok-top-level',
      cwd: directory,
      tool_name: 'spawn_agent',
      tool_input: {
        model: 'tool-arg-model',
        session_id: 'tool-arg-session',
        cwd: elsewhere,
        hook_event_name: 'SessionEnd'
      }
    })
  );

  const state = readState(stateFile);
  assert.equal(state.sessions['tool-arg-session'], undefined, 'nested session_id is not the session');
  const session = state.sessions['grok-top-level'];
  assert.ok(session, 'top-level session_id is the session');
  assert.equal(session.model, undefined, 'a tool argument named model is not the Grok model');
  assert.equal(path.resolve(session.cwd), path.resolve(directory), 'nested cwd is ignored');
  assert.equal(session.status, 'running', 'nested event name is ignored');
});

test('Grok top-level model is still honoured', async (t) => {
  const { directory, env, stateFile } = createTestEnvironment(t);
  await runCli(
    ['grok-hook', '--event', 'UserPromptSubmit'],
    env,
    15000,
    JSON.stringify({ session_id: 'grok-explicit', cwd: directory, model: 'grok-explicit-model' })
  );
  assert.equal(readState(stateFile).sessions['grok-explicit'].model, 'grok-explicit-model');
});

test('Antigravity install refuses a corrupt hooks.json and leaves it untouched', async (t) => {
  const { env } = createTestEnvironment(t);
  const hooksFile = env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOOKS_FILE;
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const jsonc = '{\n  // user comment\n  "mine": { "Stop": [{ "type": "command", "command": "echo hi" }] },\n}\n';
  fs.writeFileSync(hooksFile, jsonc);

  await assert.rejects(
    runCli(['hooks', 'setup', 'antigravity'], env, 30000),
    /Refusing to modify/
  );
  assert.equal(fs.readFileSync(hooksFile, 'utf8'), jsonc, 'corrupt file is byte-identical');
  assert.equal(fs.existsSync(`${hooksFile}.bak`), false, 'no backup written for a refused change');

  await assert.rejects(
    runCli(['hooks', 'uninstall', 'antigravity'], env, 30000),
    /Refusing to modify/
  );
  assert.equal(fs.readFileSync(hooksFile, 'utf8'), jsonc, 'uninstall also refuses');
});

test('Antigravity install and uninstall keep user hooks and never overwrite an existing .bak', async (t) => {
  const { env } = createTestEnvironment(t);
  const hooksFile = env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOOKS_FILE;
  const backupFile = `${hooksFile}.bak`;
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const userGroup = { Stop: [{ type: 'command', command: 'echo user-hook' }] };
  fs.writeFileSync(hooksFile, `${JSON.stringify({ mine: userGroup }, null, 2)}\n`);
  fs.writeFileSync(backupFile, 'ORIGINAL BACKUP');

  await runCli(['hooks', 'setup', 'antigravity'], env, 30000);
  await runCli(['hooks', 'setup', 'antigravity'], env, 30000);
  const installed = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  assert.deepEqual(installed.mine, userGroup, 'user hook group preserved');
  assert.ok(installed['discord-coding-status'], 'managed group written');
  assert.equal(fs.readFileSync(backupFile, 'utf8'), 'ORIGINAL BACKUP', 'existing .bak untouched by install');
  const leftovers = fs.readdirSync(path.dirname(hooksFile)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'atomic write leaves no temp files');

  await runCli(['hooks', 'uninstall', 'antigravity'], env, 30000);
  const removed = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  assert.deepEqual(removed, { mine: userGroup }, 'uninstall removes only the managed group');
  assert.equal(fs.readFileSync(backupFile, 'utf8'), 'ORIGINAL BACKUP', 'existing .bak untouched by uninstall');
});

test('Antigravity first install backs up the original once', async (t) => {
  const { env } = createTestEnvironment(t);
  const hooksFile = env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOOKS_FILE;
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const original = `${JSON.stringify({ mine: { Stop: [] } }, null, 2)}\n`;
  fs.writeFileSync(hooksFile, original);

  await runCli(['hooks', 'setup', 'antigravity'], env, 30000);
  await runCli(['hooks', 'setup', 'antigravity'], env, 30000);
  assert.equal(fs.readFileSync(`${hooksFile}.bak`, 'utf8'), original, 'backup is the pre-change file, not a re-run copy');
});

test('Antigravity Windows hook command uses quoted node path and plain cmd quoting', () => {
  const command = withPlatform('win32', () => antigravityHookCommand('C:\\Program Files\\dcs\\cli.js', 'Stop'));
  assert.ok(
    command.startsWith(`"${process.execPath}" "C:\\Program Files\\dcs\\cli.js" antigravity-hook --event Stop `),
    command
  );
  assert.ok(!command.startsWith('node '), 'never bare node');
  assert.ok(!command.includes('\\"'), 'no backslash-escaped quotes');
  assert.ok(command.endsWith('--managed-by=discord-coding-status'), command);
});

test('Muse failed binding is persisted and per-LLM-call hooks do not re-walk', async (t) => {
  const { env, stateFile } = createTestEnvironment(t);
  const input = (event) => JSON.stringify({ hook_event_name: event, session_id: 'muse-negative', model: 'muse-spark-1.3' });

  await runCli(['muse-hook', '--event', 'PreLLMCall'], env, 15000, input('PreLLMCall'));
  const first = readState(stateFile).sessions['muse-negative'];
  assert.ok(first, 'session recorded');
  assert.equal(first.musePid, undefined, 'no Muse ancestor in the test process tree');
  assert.equal(typeof first.museBindAttemptedAt, 'number', 'negative binding attempt persisted');

  await new Promise((resolve) => setTimeout(resolve, 30));
  await runCli(['muse-hook', '--event', 'PostLLMCall'], env, 15000, input('PostLLMCall'));
  const second = readState(stateFile).sessions['muse-negative'];
  assert.equal(second.museBindAttemptedAt, first.museBindAttemptedAt, 'PostLLMCall reused the negative result (no re-walk)');
  assert.ok(second.updated_at > first.updated_at, 'session itself still updated');
  assert.equal(second.model, 'muse-spark-1.3');

  await new Promise((resolve) => setTimeout(resolve, 30));
  await runCli(['muse-hook', '--event', 'UserPromptSubmit'], env, 15000, input('UserPromptSubmit'));
  const third = readState(stateFile).sessions['muse-negative'];
  assert.ok(third.museBindAttemptedAt > first.museBindAttemptedAt, 'human-paced event retries the walk');
});

test('Muse exec model cache re-reads a session log when it changes', (t) => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-exec-cache-'));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdg;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previous;
    }
    fs.rmSync(xdg, { recursive: true, force: true });
  });

  const uuid = '55555555-5555-4555-8555-555555555555';
  const startedAt = Date.now();
  const micros = (ms) => ms * 1000;
  const record = (payloadType, payload, at, sequence) => ({
    schema_version: 1,
    id: `cache-${sequence}`,
    stream: { kind: 'session', id: uuid },
    sequence,
    recorded_at: micros(at),
    record_type: 'event',
    payload_type: payloadType,
    payload
  });
  const dir = path.join(xdg, 'muse', 'sessions', '2026', '11', '03', uuid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    record('runtime.session.route_facts', { kind: 'route_facts', record: { pid: 4242 } }, startedAt + 10, 1),
    record('run.model.configured', { kind: 'run_model', record: { model_id: 'muse-model-a' } }, startedAt + 100, 2)
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

  const proc = {
    pid: 4242,
    line: `muse exec --session-id ${uuid}`,
    raw: `muse exec --session-id ${uuid}`,
    executablePath: '/usr/local/bin/muse',
    commandLine: `muse exec --session-id ${uuid}`,
    createdAtMs: startedAt
  };
  assert.equal(readMuseExecModelForProcess(proc).model, 'muse-model-a');
  assert.equal(readMuseExecModelForProcess(proc).model, 'muse-model-a', 'cached read is identical');

  fs.appendFileSync(file, JSON.stringify(
    record('run.model.configured', { kind: 'run_model', record: { model_id: 'muse-model-b' } }, startedAt + 200, 3)
  ) + '\n');
  assert.equal(readMuseExecModelForProcess(proc).model, 'muse-model-b', 'appended model switch is picked up');

  const duplicateDir = path.join(xdg, 'muse', 'sessions', '2026', '11', '04', uuid);
  fs.mkdirSync(duplicateDir, { recursive: true });
  fs.copyFileSync(file, path.join(duplicateDir, 'session.jsonl'));
  assert.equal(readMuseExecModelForProcess(proc), null, 'a newer duplicate log is found and stays ambiguous');

  fs.rmSync(duplicateDir, { recursive: true, force: true });
  assert.equal(readMuseExecModelForProcess(proc).model, 'muse-model-b', 'removed duplicate drops out');
});

test('hooks setup restarts the daemon when an installer refuses to write', () => {
  const { runHooksCommand } = require('../dist/commands/hooks/command');
  let restarts = 0;
  const refusing = {
    capability: 'antigravity',
    label: 'Antigravity',
    install: () => {
      throw new Error('Refusing to modify hooks.json: it does not parse');
    },
    uninstall: () => ({ removed: 0, target: 'x' }),
    status: () => ({})
  };
  assert.throws(
    () => runHooksCommand('hooks', ['setup', 'antigravity'], {
      appTitle: 'Discord Coding Status',
      getRuntimeScriptPath: () => 'cli.js',
      installers: [refusing],
      detectedInstallers: () => [refusing],
      findInstaller: (name) => (name === 'antigravity' ? refusing : null),
      restartDaemon: () => {
        restarts += 1;
        return { status: 'restarted' };
      }
    }),
    /Refusing to modify/
  );
  assert.equal(restarts, 1, 'the runtime copy stopped the daemon, so it must come back up');
});
