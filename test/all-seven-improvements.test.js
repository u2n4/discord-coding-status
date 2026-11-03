'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { isAntigravityProcess } = require('../dist/core/detection/tool-detection');
const {
  getAntigravityStateFile,
  normalizeAntigravityModel,
  pairFromGenerationRecord,
  parseAntigravityStateModel,
  readActiveAntigravityModel,
  readAntigravityStateModel
} = require('../dist/providers/antigravity/model');
const {
  DEFAULT_ANTIGRAVITY_CLIENT_ID,
  antigravityDesktopProvider
} = require('../dist/providers/antigravity/provider');
const {
  DEFAULT_MUSE_CLIENT_ID,
  DEFAULT_MUSE_IMAGE_KEY,
  museCliProvider
} = require('../dist/providers/muse/provider');
const {
  parseCodexConfigTomlModel,
  parseCodexGlobalStateModel,
  readCodexConfiguredModel
} = require('../dist/providers/codex/model');
const {
  parseGrokConfigTomlModel,
  readGrokSessionSummaryModel
} = require('../dist/providers/grok/model');
const {
  readMuseSettingsModel
} = require('../dist/providers/muse/model');
const {
  resolveDiscordApplications,
  discordApplicationForTool
} = require('../dist/providers/discord');
const {
  toolProviders
} = require('../dist/providers/registry');
const {
  buildPresence,
  enrichToolForPresence,
  selectNewestTool
} = require('../dist/presence');
const {
  familyForForegroundProcess
} = require('../dist/adapters/system/foreground');
const {
  installManagedAntigravityHooks,
  getManagedAntigravityHookStatus,
  removeManagedAntigravityHooks
} = require('../dist/antigravity-hooks');
const {
  createTestEnvironment,
  runCli
} = require('./helpers');

test('1. Muse Code uses its dedicated Discord Application ID and supports defaultImageKey capability', () => {
  assert.equal(museCliProvider.discord.defaultClientId, DEFAULT_MUSE_CLIENT_ID);

  const apps = resolveDiscordApplications(toolProviders, (_name, fallback = '') => fallback);
  const museApp = apps.get('muse');
  assert.ok(museApp);
  assert.equal(museApp.clientId, DEFAULT_MUSE_CLIENT_ID);
  assert.equal(museApp.imageKey, '');

  const customApps = resolveDiscordApplications(
    [{ ...museCliProvider, discord: { ...museCliProvider.discord, defaultImageKey: DEFAULT_MUSE_IMAGE_KEY } }],
    (_name, fallback = '') => fallback
  );
  assert.equal(customApps.get('muse').imageKey, DEFAULT_MUSE_IMAGE_KEY);
});

test('2. Antigravity process detection, provider registration, and model normalization', (t) => {
  // Isolate from the real ~/.gemini so learned records cannot change results.
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-ag-empty-'));
  const prevHome = process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOME;
  process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOME = emptyHome;
  t.after(() => {
    if (prevHome === undefined) {
      delete process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOME;
    } else {
      process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOME = prevHome;
    }
    fs.rmSync(emptyHome, { recursive: true, force: true });
  });

  assert.equal(antigravityDesktopProvider.discord.defaultClientId, '1558457305995939962');
  assert.equal(DEFAULT_ANTIGRAVITY_CLIENT_ID, '1558457305995939962');

  assert.equal(
    isAntigravityProcess({
      line: 'C:\\Users\\aliha\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
      executablePath: 'C:\\Users\\aliha\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
      commandLine: '"C:\\Users\\aliha\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe"'
    }),
    true
  );

  assert.equal(
    isAntigravityProcess({
      line: 'Antigravity.exe --type=renderer',
      executablePath: 'C:\\Users\\aliha\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
      commandLine: '"C:\\Users\\aliha\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --type=renderer'
    }),
    false,
    'Chromium renderer sub-processes must be excluded'
  );

  assert.equal(normalizeAntigravityModel('Gemini 4 Argon (Medium)'), 'Gemini 4 Argon');
  assert.equal(normalizeAntigravityModel('Claude Opus 4.6 (Thinking)'), 'Claude Opus 4.6');
  assert.equal(normalizeAntigravityModel('auto'), null);

  // Placeholders resolve only to provider ids proven by Antigravity's own
  // generation records; an unproven placeholder stays app-only.
  assert.equal(
    parseAntigravityStateModel('last_selected_agent_model:  MODEL_PLACEHOLDER_M318'),
    'gemini-3.8-flash-n'
  );
  assert.equal(
    parseAntigravityStateModel('last_selected_agent_model:  MODEL_PLACEHOLDER_M418'),
    'gemini-4-argon-trial'
  );
  assert.equal(
    parseAntigravityStateModel('last_selected_agent_model:  MODEL_PLACEHOLDER_M402'),
    'claude-opus-5-5-high'
  );
  assert.equal(
    parseAntigravityStateModel('last_selected_agent_model:  MODEL_PLACEHOLDER_M404'),
    null,
    'Sonnet/Opus split is unproven for M404: must not guess'
  );

  assert.deepEqual(
    pairFromGenerationRecord(Buffer.from('\u0012\u0016MODEL_PLACEHOLDER_M402\u001a\u0014claude-opus-5-5-high\u0000')),
    ['MODEL_PLACEHOLDER_M402', 'claude-opus-5-5-high']
  );
  assert.equal(pairFromGenerationRecord(Buffer.from('RESOURCE_EXHAUSTED MODEL_PLACEHOLDER_M404')), null);
  assert.equal(pairFromGenerationRecord(Buffer.alloc(30_000, 97)), null);
});

test('3. Antigravity hooks install cleanly and antigravity-hook outputs valid JSON', async (t) => {
  const { directory, env, stateFile } = createTestEnvironment(t);
  const hooksFile = env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOOKS_FILE;
  const antigravityHome = env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOME;

  const convId = 'test-conv-123';
  const transcriptFile = path.join(
    antigravityHome,
    'brain',
    convId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  // The transcript names a model the user typed about; it must be ignored.
  fs.writeFileSync(
    transcriptFile,
    `${JSON.stringify({
      step_index: 2,
      content: '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Claude Sonnet 4.6 (Thinking) to Gemini 4 Argon (Medium).\n</USER_SETTINGS_CHANGE>'
    })}\n`
  );
  fs.writeFileSync(
    path.join(antigravityHome, 'antigravity_state.pbtxt'),
    'last_selected_agent_model:  MODEL_PLACEHOLDER_M418\n'
  );

  const hookInput = JSON.stringify({
    conversationId: convId,
    workspacePaths: [directory],
    transcriptPath: transcriptFile,
    modelName: 'auto'
  });

  const result = await runCli(
    ['antigravity-hook', '--event', 'PreInvocation'],
    env,
    10000,
    hookInput
  );
  assert.deepEqual(JSON.parse(result.stdout.trim()), {});

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const session = state.sessions[convId];
  assert.ok(session);
  assert.equal(session.tool, 'antigravity');
  assert.equal(session.model, 'gemini-4-argon-trial');

  assert.equal(session.status, 'thinking');
});

test('4. Claude Code vs. Codex priority and subagent foreground attribution', () => {
  const claudeHook = {
    key: 'state:claude-1',
    providerId: 'claudeCode',
    family: 'claude',
    source: 'hook',
    updatedAt: 1000,
    details: 'Model: claude-opus-4-7',
    state: ''
  };
  const codexHook = {
    key: 'state:codex-1',
    providerId: 'codexCli',
    family: 'codex',
    source: 'hook',
    updatedAt: 2000,
    details: 'Model: gpt-5.4',
    state: ''
  };

  // Without explicit focus preference, Claude wins over Codex even when Codex hook updated later
  const winnerNoFocus = selectNewestTool([codexHook, claudeHook], null);
  assert.equal(winnerNoFocus.family, 'claude');

  // When the user explicitly focused Codex, Codex wins
  const winnerCodexFocused = selectNewestTool([codexHook, claudeHook], 'codex');
  assert.equal(winnerCodexFocused.family, 'codex');

  // When the user explicitly focused Claude, Claude wins
  const winnerClaudeFocused = selectNewestTool([codexHook, claudeHook], 'claude');
  assert.equal(winnerClaudeFocused.family, 'claude');

  // When WindowsTerminal hosts Claude (pid 200) which spawns Codex (pid 300) as a child subagent,
  // foreground attribution stays on Claude instead of reporting null ambiguity.
  const processes = [
    { pid: 100, ppid: 1, line: 'WindowsTerminal.exe', raw: 'WindowsTerminal.exe', executablePath: 'C:\\WindowsTerminal.exe' },
    { pid: 200, ppid: 100, line: 'claude.exe', raw: 'claude.exe', executablePath: 'C:\\Users\\aliha\\.local\\bin\\claude.exe' },
    { pid: 300, ppid: 200, line: 'codex.exe exec', raw: 'codex.exe exec', executablePath: 'C:\\Users\\aliha\\codex.exe' }
  ];
  assert.equal(familyForForegroundProcess(100, processes, toolProviders), 'claude');
});

test('5. Codex immediate model update from config.toml and .codex-global-state.json', async (t) => {
  assert.equal(
    parseCodexConfigTomlModel('model = "gpt-5.4-mini"\nmodel_reasoning_effort = "high"\n'),
    'gpt-5.4-mini'
  );
  assert.equal(
    parseCodexGlobalStateModel(JSON.stringify({
      'electron-saved-workspace-state': { model: 'gpt-5.3-codex' }
    })),
    'gpt-5.3-codex'
  );

  const tmpCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-codex-model-'));
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmpCodexHome;
  t.after(() => {
    if (prevCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prevCodexHome;
    }
    fs.rmSync(tmpCodexHome, { recursive: true, force: true });
  });

  const configPath = path.join(tmpCodexHome, 'config.toml');
  fs.writeFileSync(configPath, 'model = "gpt-5.4-mini"\n');
  const fileStat = fs.statSync(configPath);

  const enriched = await enrichToolForPresence({
    key: 'state:codex-1',
    providerId: 'codexCli',
    family: 'codex',
    source: 'hook',
    model: 'gpt-5.4',
    updatedAt: Math.floor(fileStat.mtimeMs) - 5000,
    details: 'Using Codex',
    state: 'Codex'
  });
  // Missing from the Codex list: written in the CLI list's own style.
  assert.equal(enriched.details, 'Model: GPT-5.4-Mini');
});

test('6. Grok session summary.json and Muse settings.json model resolution', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-grok-muse-'));
  const prevGrokHome = process.env.DISCORD_CODING_STATUS_GROK_HOME;
  const prevMuseSettings = process.env.DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE;
  const museSettingsFile = path.join(tmpDir, 'muse-settings.json');
  process.env.DISCORD_CODING_STATUS_GROK_HOME = path.join(tmpDir, '.grok');
  process.env.DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE = museSettingsFile;

  t.after(() => {
    if (prevGrokHome === undefined) {
      delete process.env.DISCORD_CODING_STATUS_GROK_HOME;
    } else {
      process.env.DISCORD_CODING_STATUS_GROK_HOME = prevGrokHome;
    }
    if (prevMuseSettings === undefined) {
      delete process.env.DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE;
    } else {
      process.env.DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE = prevMuseSettings;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const cwd = 'C:\\Users\\aliha\\project';
  const sessionId = 'grok-session-abc';
  const summaryDir = path.join(
    process.env.DISCORD_CODING_STATUS_GROK_HOME,
    'sessions',
    encodeURIComponent(cwd),
    sessionId
  );
  fs.mkdirSync(summaryDir, { recursive: true });
  fs.writeFileSync(
    path.join(summaryDir, 'summary.json'),
    JSON.stringify({
      info: { id: sessionId },
      current_model_id: 'grok-4.20-0309-reasoning'
    })
  );

  const grokModel = readGrokSessionSummaryModel(sessionId, cwd);
  assert.ok(grokModel);
  assert.equal(grokModel.model, 'grok-4.20-0309-reasoning');

  const enrichedGrok = await enrichToolForPresence({
    key: `state:${sessionId}`,
    providerId: 'grokCli',
    family: 'grok',
    source: 'hook',
    sessionId,
    cwd,
    model: null,
    updatedAt: 1000,
    details: 'Using Grok',
    state: 'Grok Code'
  });
  assert.equal(enrichedGrok.details, 'Model: grok-4.20-0309-reasoning');

  fs.writeFileSync(museSettingsFile, JSON.stringify({ model: 'muse-spark' }));
  const museSettings = readMuseSettingsModel();
  assert.ok(museSettings);
  assert.equal(museSettings.model, 'muse-spark');

  const enrichedMuse = await enrichToolForPresence({
    key: 'state:muse-hook-1',
    providerId: 'museCli',
    family: 'muse',
    source: 'hook',
    model: null,
    updatedAt: 1000,
    details: 'Using Muse',
    state: 'Muse Code'
  });
  // settings.json is the global default, not this session's model: a hook
  // session without a bound model stays app-only.
  assert.equal(enrichedMuse.details, '');
});
