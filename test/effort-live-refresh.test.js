'use strict';

// Effort/model freshness and attribution fixes (2026-11-27):
//  - T3-hosted Codex turns (rollout originator "T3 Code") never become a Codex CLI session.
//  - Claude Code hook sessions keep their transcript path and the daemon follows
//    effort/model changes written after the last hook (per-tool hooks skipped).
//  - "<synthetic>" assistant records are not a Claude model.
//  - Claude Desktop runners started by the utility helper still name the model.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-effort-live-'));
const ENV_OVERRIDES = {
  DISCORD_CODING_STATUS_STATE_FILE: path.join(root, 'states.json'),
  CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
  CODEX_HOME: path.join(root, 'codex-home'),
  DISCORD_CODING_STATUS_CLAUDE_DESKTOP_SESSIONS: path.join(root, 'claude-desktop-sessions')
};
const envBackup = new Map();
for (const [key, value] of Object.entries(ENV_OVERRIDES)) {
  envBackup.set(key, process.env[key]);
  process.env[key] = value;
}

const { createTestEnvironment, runCli } = require('./helpers');
const {
  codexHookSurfaceFromSessionMeta,
  isT3HostedCodexOriginator,
  readCodexSessionMeta,
  readLiveCodexTurnMetadata
} = require('../dist/state-store');
const {
  extractClaudeModelFromTranscriptJsonl,
  readLiveClaudeTranscriptMetadata,
  resetLiveClaudeTranscriptCacheForTests
} = require('../dist/claude-hooks');
const { enrichToolForPresence, readDesktopHostedClaudeModel, toolFromSession } = require('../dist/presence');

test.after(() => {
  for (const [key, value] of envBackup.entries()) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function writeLines(filePath, records, mtimeMs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  if (mtimeMs !== undefined) {
    fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
  }
}

function readSessions(stateFile) {
  return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions : {};
}

test('Codex rollouts hosted by T3 Code are T3 surface, exec stays exec, CLI/Desktop stay cli', () => {
  for (const originator of ['T3 Code', 't3code', 'T3-Code', 'T3']) {
    assert.equal(isT3HostedCodexOriginator(originator), true, originator);
  }
  for (const originator of ['Codex Desktop', 'codex_cli_rs', 'codex_exec', 'T3X', '', null]) {
    assert.equal(isT3HostedCodexOriginator(originator), false, String(originator));
  }
  assert.equal(codexHookSurfaceFromSessionMeta({ source: 'exec', originator: 'codex_exec' }), 'exec');
  assert.equal(codexHookSurfaceFromSessionMeta({ source: 'vscode', originator: 'T3 Code' }), 't3');
  assert.equal(codexHookSurfaceFromSessionMeta({ source: 'vscode', originator: 'Codex Desktop' }), 'cli');
  assert.equal(codexHookSurfaceFromSessionMeta({ source: 'cli', originator: 'codex_cli_rs' }), 'cli');
  assert.equal(codexHookSurfaceFromSessionMeta({ source: null, originator: null }), 'cli');

  const rollout = path.join(root, 'meta', 'rollout.jsonl');
  writeLines(rollout, [
    { type: 'session_meta', payload: { source: 'vscode', originator: 'T3 Code', base_instructions: { text: 'x'.repeat(300_000) } } },
    { type: 'turn_context', payload: { model: 'gpt-6.2-sol', effort: 'high' } }
  ]);
  assert.deepEqual(readCodexSessionMeta(rollout), { source: 'vscode', originator: 'T3 Code' });
  assert.deepEqual(readCodexSessionMeta(path.join(root, 'meta', 'missing.jsonl')), { source: null, originator: null });
});

test('codex-hook drops T3-hosted turns but still records Codex Desktop and CLI turns', async (t) => {
  const { env, stateFile } = createTestEnvironment(t);
  const sessionsDir = path.join(env.CODEX_HOME, 'sessions', '2026', '11', '27');
  const rollout = (id, originator, source = 'vscode') => {
    const file = path.join(sessionsDir, `rollout-2026-11-27T18-11-16-${id}.jsonl`);
    writeLines(file, [
      { type: 'session_meta', payload: { id, source, originator } },
      { type: 'turn_context', payload: { model: 'gpt-6.2-sol', effort: 'high' } }
    ]);
    return file;
  };

  const t3Id = '01a21d8f-85d9-7170-a337-92c354c53b86';
  await runCli(['codex-hook', '--event', 'UserPromptSubmit'], env, 15000,
    JSON.stringify({ session_id: t3Id, cwd: process.cwd(), transcript_path: rollout(t3Id, 'T3 Code') }));
  assert.equal(readSessions(stateFile)[t3Id], undefined, 'a T3-hosted Codex turn must not become a Codex session');

  const desktopId = '22222222-2222-4222-8222-222222222222';
  await runCli(['codex-hook', '--event', 'UserPromptSubmit'], env, 15000,
    JSON.stringify({ session_id: desktopId, cwd: process.cwd(), transcript_path: rollout(desktopId, 'Codex Desktop') }));
  const cliId = '33333333-3333-4333-8333-333333333333';
  await runCli(['codex-hook', '--event', 'UserPromptSubmit'], env, 15000,
    JSON.stringify({ session_id: cliId, cwd: path.join(process.cwd(), 'test'), transcript_path: rollout(cliId, 'codex_cli_rs', 'cli') }));
  const sessions = readSessions(stateFile);
  assert.equal(sessions[desktopId]?.surface, 'cli');
  assert.equal(sessions[desktopId]?.effort, 'high');
  assert.equal(sessions[cliId]?.surface, 'cli');
  assert.equal(sessions[cliId]?.model, 'gpt-6.2-sol');
  assert.equal(typeof sessions[cliId]?.transcript_path, 'string');
  assert.equal(toolFromSession(sessions[cliId]).transcriptPath, sessions[cliId].transcript_path);
});

test('Codex CLI presence follows the turn_context written after the last hook', async () => {
  const now = Date.now();
  const updatedAt = now - 60_000;
  const rollout = path.join(root, 'codex-live', 'rollout-live.jsonl');
  const tool = {
    key: 'state:codex-live',
    providerId: 'codexCli',
    family: 'codex',
    source: 'hook',
    model: 'gpt-6.2-sol',
    effort: 'high',
    updatedAt,
    details: '',
    state: 'Codex',
    transcriptPath: rollout
  };
  const meta = { type: 'session_meta', payload: { source: 'cli', originator: 'codex_cli_rs' } };

  // Older than the hook: the hook's own value stands.
  writeLines(rollout, [meta, { type: 'turn_context', payload: { model: 'gpt-6.2-sol', effort: 'xhigh' } }], updatedAt - 1_000);
  assert.equal(readLiveCodexTurnMetadata(rollout, updatedAt), null);
  assert.equal((await enrichToolForPresence(tool)).details, 'Model: GPT-6.2-Sol');

  // The running turn's context (written after UserPromptSubmit) wins.
  writeLines(rollout, [
    meta,
    { type: 'turn_context', payload: { model: 'gpt-6.2-sol', effort: 'high' } },
    { type: 'turn_context', payload: { model: 'gpt-6.2-sol', effort: 'xhigh' } }
  ], now);
  assert.deepEqual(readLiveCodexTurnMetadata(rollout, updatedAt), { model: 'gpt-6.2-sol', effort: 'xhigh' });
  assert.equal((await enrichToolForPresence(tool)).details, 'Model: GPT-6.2-Sol (XHigh)');

  assert.equal(readLiveCodexTurnMetadata('//server/share/rollout.jsonl', 0), null);
});

test('"<synthetic>" assistant records never become the Claude model', () => {
  const jsonl = [
    { type: 'assistant', message: { model: 'claude-opus-5-5' } },
    { type: 'assistant', message: { model: '<synthetic>' } }
  ].map((record) => JSON.stringify(record)).join('\n');
  assert.equal(extractClaudeModelFromTranscriptJsonl(jsonl), 'claude-opus-5-5');
  assert.equal(extractClaudeModelFromTranscriptJsonl(JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } })), null);
});

test('claude-hook stores the transcript path the daemon re-reads', async (t) => {
  const { env, stateFile } = createTestEnvironment(t);
  const transcriptPath = path.join(env.CLAUDE_CONFIG_DIR, 'projects', 'demo', 'claude-live.jsonl');
  writeLines(transcriptPath, [
    { type: 'assistant', message: { model: 'claude-opus-5-5' } },
    { type: 'api-request', params: { model: 'claude-opus-5-5', output_config: { effort: 'xhigh' } } }
  ]);
  await runCli(['claude-hook', '--event', 'UserPromptSubmit'], env, 15000,
    JSON.stringify({ session_id: 'claude-live', cwd: process.cwd(), transcript_path: transcriptPath }));
  const session = readSessions(stateFile)['claude-live'];
  assert.equal(session.transcript_path, transcriptPath);
  assert.equal(session.effort, 'xhigh');
  assert.equal(toolFromSession(session).transcriptPath, transcriptPath);
});

test('Claude Code presence follows effort and model written after the last hook', async () => {
  resetLiveClaudeTranscriptCacheForTests();
  const now = Date.now();
  const updatedAt = now - 60_000;
  const transcriptPath = path.join(root, 'claude-projects', 'demo', 'live-session.jsonl');
  const tool = {
    key: 'state:live-session',
    providerId: 'claudeCode',
    family: 'claude',
    source: 'hook',
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    updatedAt,
    details: '',
    state: 'Claude Code',
    transcriptPath
  };

  // Written before the last hook: the hook already read it, its value stands.
  writeLines(transcriptPath, [
    { type: 'assistant', message: { model: 'claude-opus-5-5' } },
    { type: 'api-request', params: { model: 'claude-opus-5-5', output_config: { effort: 'high' } } }
  ], updatedAt - 1_000);
  assert.equal(readLiveClaudeTranscriptMetadata(transcriptPath, updatedAt), null);
  assert.equal((await enrichToolForPresence(tool)).details, 'Model: Opus 5.5 (XHigh)');

  // `/effort max` then a prompt: the new turn's request lands after the hook.
  writeLines(transcriptPath, [
    { type: 'assistant', message: { model: 'claude-opus-5-5' } },
    { type: 'api-request', params: { model: 'claude-opus-5-5', output_config: { effort: 'max' } } }
  ], now);
  assert.equal((await enrichToolForPresence(tool)).details, 'Model: Opus 5.5 (Max)');

  // Lowered to high mid-session: the stale XHigh from the hook is dropped.
  writeLines(transcriptPath, [
    { type: 'assistant', message: { model: 'claude-opus-5-5' } },
    { type: 'api-request', params: { model: 'claude-opus-5-5', output_config: { effort: 'high' } } }
  ], now + 1_000);
  assert.equal((await enrichToolForPresence(tool)).details, 'Model: Opus 5.5');

  // `/model` switch plus a synthetic record afterwards keeps the real model.
  writeLines(transcriptPath, [
    { type: 'api-request', params: { model: 'claude-fable-5-2', output_config: { effort: 'max' } } },
    { type: 'assistant', message: { model: 'claude-fable-5-2' } },
    { type: 'assistant', message: { model: '<synthetic>' } }
  ], now + 2_000);
  assert.equal((await enrichToolForPresence(tool)).details, 'Model: Fable 5.2 (Max)');

  // A transcript without effort evidence keeps the hook's effort.
  writeLines(transcriptPath, [
    { type: 'assistant', message: { model: 'claude-opus-5-5' } }
  ], now + 3_000);
  assert.equal((await enrichToolForPresence(tool)).details, 'Model: Opus 5.5 (XHigh)');

  // Network paths are never read in the background.
  if (process.platform === 'win32') {
    assert.equal(readLiveClaudeTranscriptMetadata('\\\\server\\share\\t.jsonl', 0), null);
    assert.equal(readLiveClaudeTranscriptMetadata('//server/share/t.jsonl', 0), null);
  } else {
    assert.equal(readLiveClaudeTranscriptMetadata('//server/share/t.jsonl', 0), null);
  }
  assert.equal(readLiveClaudeTranscriptMetadata(path.join(root, 'missing.jsonl'), 0), null);
  assert.equal(readLiveClaudeTranscriptMetadata('relative/path.jsonl', 0), null);
});

test('Claude Desktop runners started by its utility helper still name the model', () => {
  fs.mkdirSync(path.dirname(ENV_OVERRIDES.DISCORD_CODING_STATUS_STATE_FILE), { recursive: true });
  fs.writeFileSync(ENV_OVERRIDES.DISCORD_CODING_STATUS_STATE_FILE, JSON.stringify({ version: 1, sessions: {} }));
  const desktopPid = 38056;
  const desktopExe = 'C:\\Program Files\\WindowsApps\\Claude_7.37095.0.0_x64__pzs8sxr\\app\\Claude.exe';
  const runnerExe = 'C:\\Users\\demo\\AppData\\Local\\Claude-Data\\claude_demo\\claude.exe';
  const desktop = { pid: desktopPid, ppid: 11656, executablePath: desktopExe, line: desktopExe, commandLine: `"${desktopExe}"` };
  const helper = {
    pid: 4744, ppid: desktopPid, executablePath: desktopExe, line: desktopExe,
    commandLine: `"${desktopExe}" --type=utility --utility-sub-type=node.mojom.NodeService`
  };
  const runner = {
    pid: 44756, ppid: helper.pid, executablePath: runnerExe, createdAtMs: Date.now() - 60_000, line: runnerExe,
    commandLine: `"${runnerExe}" --output-format stream-json --verbose --model=claude-opus-5-5 --permission-mode=auto`
  };

  assert.equal(readDesktopHostedClaudeModel(desktopPid, [desktop, helper, runner]), 'Opus 5.5');
  // Runners directly under the Desktop process keep working.
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [desktop, { ...runner, ppid: desktopPid }]), 'Opus 5.5');
  // A parent that is not the Desktop's own binary is not a Desktop helper.
  const stranger = { ...helper, executablePath: 'C:\\Tools\\other.exe' };
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [desktop, stranger, runner]), null);
  // Without the Desktop process in the census its helpers cannot be proven.
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [helper, runner]), null);
  // A helper of another Desktop instance is not this one's.
  assert.equal(readDesktopHostedClaudeModel(desktopPid, [desktop, { ...helper, ppid: 99 }, runner]), null);
});
