'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import DiscordRPC from 'discord-rpc';
import {
  DISCORD_APPLICATIONS,
  LARGE_IMAGE_KEY,
  SMALL_IMAGE_KEY,
  FALLBACK_CLIENT_ID,
  MAX_PRESENCE_TEXT_LENGTH,
  RECONNECT_INTERVAL_MS,
  CONNECT_TIMEOUT_MS,
  execFileSyncString,
  logError
} from './env';
import {
  statusLabel,
  joinPresenceParts,
  sanitizeBranchName,
  truncatePresenceText,
  titleCase,
  surfaceLabel,
  statePriority,
  sessionDetails
} from './presence-text';
import {
  cleanupStateSessions,
  coerceStateTimestamp,
  debugLog,
  log,
  readLiveCodexTurnMetadata,
  readStateFile
} from './state-store';
import {
  claudeUsageRevisionBySession,
  toolFamilyForTool
} from './quota';
import {
  findToolProviderByAlias,
  toolProviders
} from './providers/registry';
import { discordApplicationForTool } from './providers/discord';
import { readMuseExecModelForProcess, readMuseSettingsEffort, readMuseTuiModelForProcess } from './providers/muse/model';
import { parseCodexCommandLine, readCodexConfiguredModel, readCodexDesktopModel } from './providers/codex/model';
import { readClaudeSettingsEffort, readLiveClaudeTranscriptMetadata } from './claude-hooks';
import { readGrokProcessModel, readGrokSessionSummaryModel } from './providers/grok/model';
import { readOpenCodeModel } from './providers/opencode/model';
import { readCursorModel } from './providers/cursor/model';
import { readLastUsedClaudeDesktopSession } from './providers/claude/desktop-sessions';
import {
  readActiveAntigravityModel,
  readAntigravityCliModel,
  readAntigravityStatePlaceholder
} from './providers/antigravity/model';
import { ensureAntigravityLiveLabels } from './providers/antigravity/live-labels';
import { displayModelLabel, formatModelWithEffort } from './providers/model-label';
import { mergeEffortWithUltracode } from './core/presence/effort';
import { readT3Presence, T3_VISIBLE_AGENT_MINIMUM } from './providers/t3/model';
import type { T3WorkingAgent } from './providers/t3/model';
import { DEFAULT_T3_IMAGE_KEY, DEFAULT_T3_NIGHTLY_IMAGE_KEY } from './providers/t3/provider';
import { isT3NightlyProcess } from './core/detection/tool-detection';
import type { ModelLabelSurface } from './providers/model-label';
import { getCachedProcessList } from './adapters/system/process-cache';
import type { ActiveTool, ProcessInfo } from './core/tools/types';
import type {
  PackageInfo,
  PresencePayload
} from './core/presence/types';
import type { HookSessionState } from './core/hooks/types';
import type { RpcConnectionState } from './adapters/discord/types';

export const rpcConnections = new Map<string, RpcConnectionState>();

let shuttingDown = false;

// cli.ts owns the daemon loop; it registers a kick callback here so an RPC
// connect can trigger a fresh daemon pass without creating a circular import.
let rpcReadyKick: (() => void) | null = null;

export function setRpcReadyKick(kick: () => void): void {
  rpcReadyKick = kick;
}

export function markShuttingDown(): void {
  shuttingDown = true;
}

export function clientIdForTool(tool: ActiveTool): string | null {
  const application = discordApplicationForTool(tool, toolProviders, DISCORD_APPLICATIONS);
  if (!application) {
    // Genuinely unknown legacy tool: the only case the global fallback ID
    // still covers.
    return FALLBACK_CLIENT_ID || null;
  }

  // A known tool without its own Discord application ID (Muse until the user
  // creates one) must fail closed: publishing it under the legacy global ID
  // would show the wrong application identity on Discord.
  return application.clientId || null;
}

export function createRpcConnectionState(): RpcConnectionState {
  return {
    client: null,
    ready: false,
    reconnectTimer: null,
    connecting: null,
    activeToolKey: null,
    lastSentActivitySignature: null,
    lastCleared: true,
    connectionAttempt: 0,
    nextConnectAtMs: 0,
    reconnectDelayMs: RECONNECT_INTERVAL_MS
  };
}

export function rpcStateForClientId(clientId: string): RpcConnectionState {
  let state = rpcConnections.get(clientId);
  if (!state) {
    state = createRpcConnectionState();
    rpcConnections.set(clientId, state);
  }

  return state;
}

export function labelForClientId(clientId: string): string {
  return [...DISCORD_APPLICATIONS.values()].find(
    (application) => application.clientId === clientId
  )?.label || clientId;
}

export function cancelReconnect(state: RpcConnectionState): void {
  if (!state.reconnectTimer) {
    return;
  }

  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

const MAX_RECONNECT_DELAY_MS = 60_000;

// discord-rpc's destroy() is async and rejects when the IPC socket is already
// gone ("Cannot read properties of null (reading 'write')"); never let that
// escape as an unhandled rejection.
export function destroyRpcClient(client: any): void {
  if (!client) {
    return;
  }
  void Promise.resolve()
    .then(() => client.destroy())
    .catch(() => {});
}

function noteConnectFailure(state: RpcConnectionState): number {
  const delay = state.reconnectDelayMs || RECONNECT_INTERVAL_MS;
  state.nextConnectAtMs = Date.now() + delay;
  state.reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
  return delay;
}

function scheduleReconnect(clientId: string, delayMs: number = RECONNECT_INTERVAL_MS): void {
  const state = rpcStateForClientId(clientId);
  if (shuttingDown || state.reconnectTimer) {
    return;
  }

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connectToDiscord(clientId);
  }, delayMs);
}

export function rejectAfter(
  ms: number,
  message: string,
  capture?: (timer: ReturnType<typeof setTimeout>) => void
): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (capture) {
      capture(timer);
    }
  });
}

export async function connectToDiscord(clientId: string): Promise<void> {
  const state = rpcStateForClientId(clientId);

  if (shuttingDown || state.ready) {
    return;
  }

  if (state.connecting) {
    return state.connecting;
  }

  state.connecting = (async () => {
    const attemptId = ++state.connectionAttempt;
    let client: any | null = null;

    try {
      if (state.client) {
        // Best effort cleanup before creating a fresh IPC client.
        destroyRpcClient(state.client);
      }

      DiscordRPC.register(clientId);
      client = new DiscordRPC.Client({ transport: 'ipc' });
      state.client = client;

      client.on('ready', () => {
        if (attemptId !== state.connectionAttempt || client !== state.client) {
          return;
        }

        state.ready = true;
        state.nextConnectAtMs = 0;
        state.reconnectDelayMs = RECONNECT_INTERVAL_MS;
        log(`Connected to Discord Desktop RPC for ${labelForClientId(clientId)}.`);
        if (rpcReadyKick) {
          rpcReadyKick();
        }
      });

      client.on('disconnected', () => {
        if (!shuttingDown && attemptId === state.connectionAttempt && client === state.client) {
          state.ready = false;
          state.lastSentActivitySignature = null;
          state.lastCleared = false;
          log(`Discord RPC disconnected for ${labelForClientId(clientId)}. Will retry.`);
          scheduleReconnect(clientId);
        }
      });

      client.on('error', (error: unknown) => {
        if (!shuttingDown && attemptId === state.connectionAttempt && client === state.client) {
          logError(`Discord RPC error for ${labelForClientId(clientId)}`, error);
        }
      });

      log(`Connecting to Discord Desktop RPC for ${labelForClientId(clientId)}...`);
      const loginPromise = client.login({ clientId });
      loginPromise.catch(() => {});
      await Promise.race([
        loginPromise,
        rejectAfter(CONNECT_TIMEOUT_MS, 'Timed out while waiting for Discord RPC.', (timer) => {
          // The login promise settles exactly once; clearing here releases the
          // timeout handle on success instead of letting it linger (and fire)
          // for the full CONNECT_TIMEOUT_MS after every connect.
          void loginPromise.then(
            () => clearTimeout(timer),
            () => clearTimeout(timer)
          );
        })
      ]);
    } catch (error) {
      if (client && client === state.client) {
        // Best effort cleanup before retrying.
        destroyRpcClient(client);
        state.client = null;
      }

      state.ready = false;
      const delay = noteConnectFailure(state);
      logError(`Could not connect to Discord RPC for ${labelForClientId(clientId)}. Is Discord Desktop running? Retrying in ${Math.round(delay / 1000)}s`, error);
      scheduleReconnect(clientId, delay);
    } finally {
      if (state.connecting) {
        state.connecting = null;
      }
    }
  })();

  return state.connecting;
}

export function toolFromSession(session: HookSessionState): ActiveTool {
  const tool = session.tool.trim().toLowerCase();
  const surface = session.surface.trim().toLowerCase();
  const status = statusLabel(session.status);
  const surfaceText = surfaceLabel(surface);
  const provider = findToolProviderByAlias(tool, surface, toolProviders);

  if (tool === 'claude' || tool === 'claude-code') {
    return {
      key: `state:${session.session_id}`,
      providerId: provider?.id || 'claudeCode',
      family: 'claude',
      details: sessionDetails(session.activity, 'Using Claude Code'),
      state: joinPresenceParts(['Claude Code', surfaceText, status]),
      cwd: session.cwd,
      sessionId: session.session_id,
      startedAt: session.started_at || session.updated_at || null,
      updatedAt: session.updated_at || null,
      status: session.status,
      activity: session.activity || null,
      model: session.model || null,
      effort: session.effort || null,
      contextText: session.context || null,
      projectName: session.project || null,
      packageName: session.package || null,
      claudeQuotaEligible: session.claude_quota_eligible ?? null,
      transcriptPath: typeof session.transcript_path === 'string' && session.transcript_path.trim()
        ? session.transcript_path.trim()
        : null
    };
  }

  if (tool === 'codex') {
    return {
      key: `state:${session.session_id}`,
      providerId: provider?.id || (surface === 'app' ? 'codexApp' : 'codexCli'),
      family: 'codex',
      details: sessionDetails(session.activity, 'Using Codex'),
      state: joinPresenceParts(['Codex', surfaceText, status]),
      cwd: session.cwd,
      sessionId: session.session_id,
      startedAt: session.started_at || session.updated_at || null,
      updatedAt: session.updated_at || null,
      status: session.status,
      activity: session.activity || null,
      model: session.model || null,
      effort: session.effort || null,
      contextText: session.context || null,
      projectName: session.project || null,
      packageName: session.package || null,
      transcriptPath: typeof session.transcript_path === 'string' && session.transcript_path.trim()
        ? session.transcript_path.trim()
        : null
    };
  }

  if (provider?.presence) {
    return {
      key: `state:${session.session_id}`,
      providerId: provider.id,
      family: provider.family,
      details: sessionDetails(session.activity, provider.presence.details),
      state: joinPresenceParts([
        provider.discord?.label || provider.presence.state,
        surfaceText,
        status
      ]),
      cwd: session.cwd,
      sessionId: session.session_id,
      startedAt: session.started_at || session.updated_at || null,
      updatedAt: session.updated_at || null,
      status: session.status,
      activity: session.activity || null,
      model: session.model || null,
      effort: session.effort || null,
      contextText: session.context || null,
      projectName: session.project || null,
      packageName: session.package || null
    };
  }

  return {
    key: `state:${session.session_id}`,
    family: 'other',
    details: sessionDetails(session.activity, `Using ${titleCase(tool)}`),
    state: joinPresenceParts([surfaceText, status]),
    cwd: session.cwd,
    sessionId: session.session_id,
    startedAt: session.started_at || session.updated_at || null,
    updatedAt: session.updated_at || null,
    status: session.status,
    activity: session.activity || null,
    model: session.model || null,
    effort: session.effort || null,
    contextText: session.context || null,
    projectName: session.project || null,
    packageName: session.package || null
  };
}

function isAppSurface(tool: ActiveTool): boolean {
  if (typeof tool.providerId !== 'string') {
    return false;
  }
  const provider = toolProviders.find((candidate) => candidate.id === tool.providerId);
  return provider ? provider.process?.surface === 'desktop' : tool.providerId.endsWith('App');
}

function familyKeyForTool(tool: ActiveTool): string {
  const family = toolFamilyForTool(tool);
  return family === 'other' ? `other:${tool.key}` : family;
}

function familyKeyForSession(session: HookSessionState): string {
  return familyKeyForTool(toolFromSession(session));
}

function countStateSessionsByFamily(sessions: HookSessionState[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const key = familyKeyForSession(session);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// Claude Desktop runs hooks for its new-chat draft before any session exists
// (session_id "empty-state-draft", model "default"); that is not a session.
const CLAUDE_DESKTOP_DRAFT_SESSION_ID = 'empty-state-draft';

export function detectStateTools(): ActiveTool[] {
  const state = cleanupStateSessions(readStateFile(), Date.now());
  const sessions = Object.values(state.sessions).filter((session) => session.session_id !== CLAUDE_DESKTOP_DRAFT_SESSION_ID);
  const activeClaudeSessionIds = new Set(
    sessions
      .filter((session) => ['claude', 'claude-code'].includes(session.tool.trim().toLowerCase()))
      .map((session) => session.session_id)
  );
  for (const sessionId of claudeUsageRevisionBySession.keys()) {
    if (!activeClaudeSessionIds.has(sessionId)) {
      claudeUsageRevisionBySession.delete(sessionId);
    }
  }

  if (!sessions.length) {
    return [];
  }

  sessions.sort((a, b) => {
    const priorityDelta = statePriority(b.status) - statePriority(a.status);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return b.updated_at - a.updated_at;
  });

  const tools: ActiveTool[] = [];
  const seenFamilies = new Set<string>();
  const sessionCounts = countStateSessionsByFamily(sessions);

  for (const session of sessions) {
    const tool = toolFromSession(session);
    const key = familyKeyForTool(tool);

    if (seenFamilies.has(key)) {
      continue;
    }

    tools.push({ ...tool, source: 'hook', sessionCount: sessionCounts.get(key) || null });
    seenFamilies.add(key);
  }

  return tools;
}

export function detectStateTool(): ActiveTool | null {
  return detectStateTools()[0] || null;
}

const DESKTOP_HOSTED_MAX_AGE_MS = 30 * 60_000;

function runnerFlag(commandLine: string, name: string): string | null {
  const match = commandLine.match(new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)("?)([A-Za-z0-9][A-Za-z0-9._:@\\[\\]-]{0,80})\\1(?=\\s|$)`));
  return match ? match[2] : null;
}

// Topmost Claude.exe above a Desktop process (helpers are its children).
export function claudeDesktopHostPid(proc: ProcessInfo, processes: ProcessInfo[]): number | null {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const exe = (entry: ProcessInfo | undefined) => String(entry?.executablePath || '').trim().toLowerCase();
  let current: ProcessInfo | undefined = byPid.get(proc.pid) || proc;
  const own = exe(current);
  if (!/(?:^|[\\/])claude\.exe$/.test(own)) {
    return null;
  }
  for (let hops = 0; hops < 4; hops += 1) {
    const parent: ProcessInfo | undefined = typeof current?.ppid === 'number' ? byPid.get(current.ppid) : undefined;
    if (!parent || exe(parent) !== own) {
      break;
    }
    current = parent;
  }
  return current?.pid || null;
}

/**
 * Model of Claude Desktop's Code tab, shown when the window's own label cannot
 * be read. Every Code-tab session runs as a `claude --output-format
 * stream-json --model=<id> [--resume=<session>]` child of the Desktop
 * process, and those runners stay alive for days after their session goes
 * idle. The session the user last opened or typed in, from Desktop's own
 * records, names the model: its fresh hook (/model switches arrive there),
 * else its record, else its runner's --model flag. When none of those know,
 * or the records cannot name one session, no other session stands in. A new
 * session's runner carries no session id, so a record cannot be required to
 * have a live runner.
 *
 * Without such a record, each live runner's model is its bound hook session's
 * model (the session id it resumes, or the one unbound Code-tab hook session
 * when exactly one runner is unbound), else its --model flag, and a value is
 * returned only when every live runner agrees. A terminal Claude Code session
 * (entrypoint "cli") is never consulted.
 */
export function readDesktopHostedClaudeModel(desktopPid: number, processes: ProcessInfo[]): string | null {
  // Current Desktop builds start the runners from a Claude.exe helper (the
  // `--type=utility` Node service) rather than from the main process, so a
  // runner's parent is the Desktop process or one of its own same-binary children.
  const exePath = (proc?: ProcessInfo) => String(proc?.executablePath || '').trim().toLowerCase();
  const desktopExe = exePath(processes.find((proc) => proc.pid === desktopPid));
  const hostPids = new Set<number>([desktopPid]);
  if (desktopExe) {
    for (const proc of processes) {
      if (proc.ppid === desktopPid && exePath(proc) === desktopExe) {
        hostPids.add(proc.pid);
      }
    }
  }
  const runners = processes.filter((proc) => typeof proc.ppid === 'number' && hostPids.has(proc.ppid)
    && /(?:^|[\\/])claude(?:\.exe)?$/i.test(String(proc.executablePath || '').trim())
    && /--output-format[=\s]+stream-json/.test(String(proc.commandLine || '')));
  if (!runners.length) {
    return null;
  }
  const now = Date.now();
  const sessions = new Map<string, HookSessionState>();
  for (const session of Object.values(cleanupStateSessions(readStateFile(), now).sessions)) {
    if (['claude', 'claude-code'].includes(session.tool.trim().toLowerCase())
      && session.claude_entrypoint === 'claude-desktop'
      && typeof session.model === 'string' && session.model.trim()
      && now - session.updated_at <= DESKTOP_HOSTED_MAX_AGE_MS) {
      sessions.set(session.session_id, session);
    }
  }

  const inUse = readLastUsedClaudeDesktopSession(desktopPid, processes);
  if (inUse) {
    const runner = runners.find((proc) => {
      const commandLine = String(proc.commandLine || '');
      return runnerFlag(commandLine, 'resume') === inUse.sessionId || runnerFlag(commandLine, 'session-id') === inUse.sessionId;
    });
    const hook = sessions.get(inUse.sessionId);
    const freshHook = hook && (!runner?.createdAtMs || hook.updated_at >= runner.createdAtMs) ? hook : null;
    // A hook written before this runner started belongs to an earlier one.
    const model = freshHook?.model
      || inUse.model
      || (runner ? runnerFlag(String(runner.commandLine || ''), 'model') : null);
    const runnerEffort = runner ? parseClaudeCommandLineEffort(String(runner.commandLine || '')) : null;
    // Ultracode is an independent toggle in Claude Desktop (`sessionSettings.ultracode`,
    // explicitly set to `false` when disabled) that can pair with high/xhigh/max,
    // so Desktop's active ultracode state combines with any active effort tier.
    const hookEffort = freshHook?.effort || null;
    const desktopHasUltra = Boolean(inUse.effort && /ultracode/i.test(inUse.effort));
    const effort = desktopHasUltra
      ? mergeEffortWithUltracode(hookEffort || inUse.effort || runnerEffort, true)
      : (hookEffort || inUse.effort || runnerEffort || null);
    return model ? truncatePresenceText(formatModelWithEffort('claude', model, effort)) : null;
  }

  const bound = new Set<string>();
  const unbound: Array<{ flag: string | null; effortFlag: string | null; resume: string | null; createdAtMs: number }> = [];
  const models = new Set<string>();
  const efforts = new Set<string>();
  for (const runner of runners) {
    const commandLine = String(runner.commandLine || '');
    const flag = runnerFlag(commandLine, 'model');
    const effortFlag = parseClaudeCommandLineEffort(commandLine);
    const resume = runnerFlag(commandLine, 'resume');
    const session = resume ? sessions.get(resume) : undefined;
    // A hook written before this runner started belongs to an earlier one.
    if (session && (!runner.createdAtMs || session.updated_at >= runner.createdAtMs)) {
      bound.add(session.session_id);
      models.add(session.model as string);
      efforts.add((session.effort || effortFlag || '').trim().toLowerCase());
    } else {
      unbound.push({ flag, effortFlag, resume, createdAtMs: runner.createdAtMs || 0 });
    }
  }
  const spare = [...sessions.values()].filter((session) => !bound.has(session.session_id));
  for (const runner of unbound) {
    // Only a new session (no --resume) can be paired by elimination; a runner
    // resuming a known id never takes another session's hook.
    const session = !runner.resume && unbound.length === 1 && spare.length === 1 && spare[0].updated_at >= runner.createdAtMs
      ? spare[0]
      : null;
    const model = session?.model || runner.flag;
    if (!model) {
      return null;
    }
    models.add(model);
    efforts.add((session?.effort || runner.effortFlag || '').trim().toLowerCase());
  }
  if (models.size !== 1) {
    return null;
  }
  const agreedEffort = efforts.size === 1 ? ([...efforts][0] || null) : null;
  return truncatePresenceText(formatModelWithEffort('claude', [...models][0], agreedEffort));
}

/**
 * Live native/manual Muse hook sessions (freshness- and terminal-filtered,
 * newest last). The daemon resolves which ONE may display its model via
 * foreground instance binding; this reader only lists candidates.
 */
export function readLiveMuseHookSessions(): HookSessionState[] {
  const state = cleanupStateSessions(readStateFile(), Date.now());
  return Object.values(state.sessions)
    .filter((session) => session.tool.trim().toLowerCase() === 'muse')
    .sort((left, right) => left.updated_at - right.updated_at);
}

export function mergeActiveTools(primary: ActiveTool[], fallback: ActiveTool[]): ActiveTool[] {
  const tools: ActiveTool[] = [];
  const seen = new Set<string>();

  // One entry per family AND surface: a CLI hook must not hide the same tool's
  // desktop app (or the reverse), because selection prefers the app unless the
  // CLI is in front.
  for (const tool of [...primary, ...fallback]) {
    const key = `${familyKeyForTool(tool)}|${isAppSurface(tool) ? 'app' : 'cli'}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    tools.push(tool);
  }

  return tools;
}

function isLikelyAppInternalPath(directory: string | null | undefined): boolean {
  const normalized = String(directory || '').toLowerCase();

  return (
    !normalized ||
    normalized === '/' ||
    normalized.includes('.app/contents/') ||
    normalized.includes('/applications/codex.app') ||
    normalized.includes('/applications/discord.app')
  );
}

export function readPackageInfo(startDirectory: string | null): PackageInfo | null {
  if (!startDirectory || isLikelyAppInternalPath(startDirectory)) {
    return null;
  }

  let current = startDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    const packagePath = path.join(current, 'package.json');

    if (fs.existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        return {
          root: current,
          name: typeof packageJson.name === 'string' ? packageJson.name : null
        };
      } catch (_) {
        return {
          root: current,
          name: null
        };
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return null;
}

export function getGitBranch(directory: string | null): string | null {
  if (!directory || isLikelyAppInternalPath(directory)) {
    return null;
  }

  try {
    const branch = execFileSyncString('git', ['-C', directory, 'symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    return sanitizeBranchName(branch);
  } catch (_) {
    try {
      const commit = execFileSyncString('git', ['-C', directory, 'rev-parse', '--short', 'HEAD']).trim();
      return commit ? `detached:${commit}` : null;
    } catch (_) {
      return null;
    }
  }
}

function modelTextForPresence(tool: ActiveTool): string | null {
  const model = String(tool.model || '').replace(/\s+/g, ' ').trim();
  return model ? truncatePresenceText(model) : null;
}

function effortTextForPresence(tool: ActiveTool): string | null {
  const effort = String(tool.effort || '').replace(/\s+/g, ' ').trim();
  return effort || null;
}

function parseClaudeCommandLineEffort(commandLine: string | null | undefined): string | null {
  if (typeof commandLine !== 'string' || !commandLine.trim()) {
    return null;
  }
  const hasUltra = /(?:^|\s)--ultracode(?:\s|$|=true)/i.test(commandLine);
  return mergeEffortWithUltracode(runnerFlag(commandLine, 'effort'), hasUltra);
}

function parseMuseCommandLineEffort(commandLine: string | null | undefined): string | null {
  if (typeof commandLine !== 'string' || !commandLine.trim()) {
    return null;
  }
  return runnerFlag(commandLine, 'reasoning-effort') || runnerFlag(commandLine, 'effort');
}

function isVerifiedLiveProcess(info: ProcessInfo | undefined): boolean {
  if (!info || typeof info.pid !== 'number' || info.pid <= 0) {
    return false;
  }
  const exe = typeof info.executablePath === 'string' ? info.executablePath.trim() : '';
  if (!exe) {
    return false;
  }
  try {
    return fs.existsSync(exe);
  } catch (_) {
    return false;
  }
}

export function formatT3WorkingAgentsState(
  workingAgents: number,
  agents: readonly T3WorkingAgent[] | undefined,
  focusedModelLabel?: string | null
): string {
  if (workingAgents < T3_VISIBLE_AGENT_MINIMUM) {
    return '';
  }
  const prefix = `${workingAgents} agents`;
  if (!agents || agents.length === 0) {
    return prefix;
  }

  const grouped = new Map<string, { label: string; count: number }>();
  for (const agent of agents) {
    if (!agent?.model) {
      continue;
    }
    const label = displayModelLabel(
      { family: 't3', providerId: agent.instanceId || undefined },
      agent.model
    ).trim();
    if (!label) {
      continue;
    }
    const key = label.toLowerCase();
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, { label, count: 1 });
    }
  }

  if (grouped.size === 0) {
    return prefix;
  }

  const focusedKey = focusedModelLabel ? focusedModelLabel.trim().toLowerCase() : '';
  const entries = [...grouped.values()].sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    const aFocused = focusedKey && a.label.toLowerCase() === focusedKey ? 1 : 0;
    const bFocused = focusedKey && b.label.toLowerCase() === focusedKey ? 1 : 0;
    if (bFocused !== aFocused) {
      return bFocused - aFocused;
    }
    return a.label.localeCompare(b.label);
  });

  const head = `${prefix} · `;
  const chosen: string[] = [];
  let length = head.length;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const token = entry.count > 1 ? `${entry.count}x ${entry.label}` : entry.label;
    const sep = chosen.length > 0 ? ', ' : '';
    const remainingCount = entries.slice(index + 1).reduce((sum, item) => sum + item.count, 0);
    const overflowReserve = remainingCount > 0 ? `, +${remainingCount}`.length : 0;
    if (chosen.length > 0 && length + sep.length + token.length + overflowReserve > MAX_PRESENCE_TEXT_LENGTH) {
      const skippedCount = entries.slice(index).reduce((sum, item) => sum + item.count, 0);
      return truncatePresenceText(`${head}${chosen.join(', ')}, +${skippedCount}`);
    }
    chosen.push(token);
    length += sep.length + token.length;
  }

  return truncatePresenceText(`${head}${chosen.join(', ')}`);
}

export async function enrichToolForPresence(tool: ActiveTool | null): Promise<ActiveTool | null> {
  if (!tool) {
    return null;
  }

  // Minimal display contract: the Discord application identity already shows
  // the tool name ("Playing Codex"), and the published line is the model
  // (plus "(XHigh)", "(Max)", or "(Ultracode)" when one of those three high
  // reasoning tiers is active). T3 Code also sends `N agents · <models>` as
  // state when at least three agents are working. No activity, project, branch,
  // quota, context, package, emoji, or timestamps are ever sent.
  let model = modelTextForPresence(tool);
  let effort = effortTextForPresence(tool);
  let labelSurface: ModelLabelSurface | ActiveTool = tool;
  let state = '';
  const updatedAtMs = coerceStateTimestamp(tool.updatedAt) || 0;

  // Model fallbacks below only fill a gap or follow a newer persisted pick
  // that belongs to the same surface. Global guesses (Muse settings.json, the
  // Grok config default) are never shown for models: unknown stays app-only.
  if (tool.family === 'claude' && tool.providerId === 'claudeApp') {
    if (!model && tool.processInfo) {
      // Desktop not in front (its window label is unread): its Code-tab sessions
      // still name the model and effort. The detected Claude.exe may be a helper
      // process, so the runners are looked up under its topmost Claude.exe.
      const processes = getCachedProcessList();
      const hostPid = claudeDesktopHostPid(tool.processInfo, processes);
      const hosted = hostPid ? readDesktopHostedClaudeModel(hostPid, processes) : null;
      if (hosted) {
        model = hosted;
      }
    }
  } else if (tool.family === 'claude') {
    if (tool.source === 'hook' && tool.transcriptPath) {
      // The transcript written since the last hook names the turn's real
      // model and effort; hooks alone lag a whole turn without per-tool hooks.
      const live = readLiveClaudeTranscriptMetadata(tool.transcriptPath, updatedAtMs);
      if (live?.model) {
        model = truncatePresenceText(live.model);
      }
      if (live?.effort) {
        effort = live.effort;
      }
    }
    if (!effort && tool.processInfo) {
      effort = parseClaudeCommandLineEffort(tool.processInfo.commandLine || tool.processInfo.line);
    }
    if (!effort && model) {
      effort = readClaudeSettingsEffort();
    }
  } else if (tool.family === 'codex') {
    if (tool.providerId === 'codexApp') {
      const desktop = readCodexDesktopModel();
      if (desktop?.model && isVerifiedLiveProcess(tool.processInfo)) {
        if (!model) {
          model = truncatePresenceText(desktop.model);
        }
        if (!effort && desktop.effort) {
          effort = desktop.effort;
        }
      }
    } else {
      const configured = readCodexConfiguredModel();
      if (tool.source === 'hook') {
        // The turn_context Codex wrote since the last hook names the running
        // turn's model and effort (UserPromptSubmit fires before it exists).
        const live = tool.transcriptPath ? readLiveCodexTurnMetadata(tool.transcriptPath, updatedAtMs) : null;
        if (live?.model) {
          model = truncatePresenceText(live.model);
        }
        if (live?.effort) {
          effort = live.effort;
        }
        if (configured?.model && (!model || (updatedAtMs > 0 && configured.mtimeMs > updatedAtMs))) {
          model = truncatePresenceText(configured.model);
        }
        if (configured?.effort && (!effort || (updatedAtMs > 0 && (configured.effortChangedAtMs || 0) > updatedAtMs))) {
          effort = configured.effort;
        }
      }
      if (tool.source === 'process' && isVerifiedLiveProcess(tool.processInfo)) {
        // `codex --model x` / `-c model_reasoning_effort=xhigh` runs those
        // overrides whatever config.toml says; a change seen in config.toml
        // after the process started is a /model or /effort switch inside it.
        const flagged = parseCodexCommandLine(tool.processInfo?.commandLine || tool.processInfo?.line);
        const startedAtMs = tool.processInfo?.createdAtMs || 0;
        if (!model) {
          const configChangedSinceStart = Boolean(configured?.model && startedAtMs > 0 && configured.observedChangeAtMs > startedAtMs);
          const picked = flagged.model && !configChangedSinceStart ? flagged.model : configured?.model;
          if (picked) {
            model = truncatePresenceText(picked);
          }
        }
        if (!effort) {
          const effortChangedSinceStart = Boolean(configured?.effort && startedAtMs > 0 && (configured.observedEffortChangeAtMs || 0) > startedAtMs);
          const pickedEffort = flagged.effort && !effortChangedSinceStart ? flagged.effort : configured?.effort;
          if (pickedEffort) {
            effort = pickedEffort;
          }
        }
      }
    }
  } else if (tool.family === 'grok') {
    if (tool.sessionId) {
      const summary = readGrokSessionSummaryModel(tool.sessionId, tool.cwd);
      const summaryNewer = Boolean(summary && updatedAtMs > 0 && summary.mtimeMs > updatedAtMs);
      if (summary?.model && (!model || summaryNewer)) {
        model = truncatePresenceText(summary.model);
      }
      if (summary?.effort && (!effort || summaryNewer)) {
        effort = summary.effort;
      }
    } else if (!model && tool.source === 'process') {
      // No hook yet: ~/.grok/active_sessions.json binds this grok.exe to its session.
      const bound = readGrokProcessModel(tool.processInfo?.pid);
      if (bound?.model) {
        model = truncatePresenceText(bound.model);
      }
      if (!effort && bound?.effort) {
        effort = bound.effort;
      }
    }
  } else if (tool.family === 'muse') {
    if (!model && tool.source === 'process' && !tool.processAmbiguous && tool.processInfo) {
      let resolved: string | null = null;
      try {
        resolved = readMuseExecModelForProcess(tool.processInfo)?.model
          || readMuseTuiModelForProcess(tool.processInfo)?.model
          || null;
      } catch (_) {
        resolved = null;
      }
      if (resolved) {
        model = truncatePresenceText(resolved);
      }
    }
    if (model && !effort) {
      effort = parseMuseCommandLineEffort(tool.processInfo?.commandLine || tool.processInfo?.line)
        || readMuseSettingsEffort(model);
    }
  } else if (tool.family === 'opencode') {
    const oc = readOpenCodeModel();
    if (!model && oc?.model) {
      model = oc.model;
    }
    if (!effort && oc?.effort) {
      effort = oc.effort;
    }
  } else if (tool.family === 'cursor' && tool.providerId === 'cursorApp') {
    // The Agent pick lives in the Cursor app's settings; the Cursor CLI
    // (cursor-agent) keeps its own and is not labelled from here.
    const cur = readCursorModel();
    if (!model && cur?.model) {
      model = cur.model;
    }
    if (!effort && cur?.effort) {
      effort = cur.effort;
    }
  } else if (tool.family === 'antigravity' && tool.providerId === 'antigravityCli') {
    const cli = readAntigravityCliModel();
    if (cli?.model) {
      const sameModel = Boolean(model && cli.model.toLowerCase() === model.toLowerCase());
      model = truncatePresenceText(cli.model);
      effort = cli.effort ?? (sameModel ? effort : null);
    }
  } else if (tool.family === 'antigravity') {
    // The UI selection is written to antigravity_state.pbtxt the moment it
    // changes, so a resolved selection is fresher than any hook payload.
    const placeholder = readAntigravityStatePlaceholder();
    ensureAntigravityLiveLabels(placeholder);
    const active = readActiveAntigravityModel();
    if (active?.model) {
      model = truncatePresenceText(active.model);
      effort = active.effort ?? null;
    } else if (placeholder) {
      // A current selection we cannot prove beats any older hook model.
      model = null;
      effort = null;
    }
  } else if (tool.family === 't3') {
    // The thread on screen names the model and effort. A background thread that
    // was never opened does not. Working agents (with their proven models) show
    // on the second line at 3 or more.
    const snapshot = readT3Presence();
    if (snapshot?.model) {
      model = truncatePresenceText(snapshot.model);
      effort = snapshot.effort ?? null;
      labelSurface = { family: 't3', providerId: snapshot.instanceId || undefined };
    }
    if (snapshot && snapshot.workingAgents >= T3_VISIBLE_AGENT_MINIMUM) {
      const focusedLabel = model ? displayModelLabel(labelSurface, model) : null;
      state = formatT3WorkingAgentsState(snapshot.workingAgents, snapshot.workingAgentModels, focusedLabel);
    }
  }

  const formatted = model ? formatModelWithEffort(labelSurface, model, effort) : '';
  return {
    ...tool,
    details: formatted ? truncatePresenceText(`Model: ${formatted}`) : '',
    state
  };
}

export async function enrichToolsForPresence(tools: ActiveTool[]): Promise<ActiveTool[]> {
  const enriched = await Promise.all(tools.map((tool) => enrichToolForPresence(tool)));
  return enriched.filter((tool): tool is ActiveTool => Boolean(tool));
}

export function buildPresence(tool: ActiveTool): PresencePayload {
  // No startTimestamp: elapsed-time display is disabled entirely.
  const presence: PresencePayload = {
    instance: false
  };
  const largeImageKey = largeImageKeyForTool(tool);

  if (tool.details) {
    presence.details = tool.details;
  }

  if (tool.state) {
    presence.state = tool.state;
  }

  if (largeImageKey) {
    presence.largeImageKey = largeImageKey;
  }

  if (SMALL_IMAGE_KEY) {
    presence.smallImageKey = SMALL_IMAGE_KEY;
  }

  return presence;
}

function largeImageKeyForTool(tool: ActiveTool): string | null {
  const application = discordApplicationForTool(tool, toolProviders, DISCORD_APPLICATIONS);
  if (tool.family === 't3'
    && application?.imageKey === DEFAULT_T3_IMAGE_KEY
    && tool.processInfo
    && isT3NightlyProcess(tool.processInfo)) {
    return DEFAULT_T3_NIGHTLY_IMAGE_KEY;
  }
  return application?.imageKey || LARGE_IMAGE_KEY || null;
}

export function getActivitySignature(tool: ActiveTool): string {
  return [
    clientIdForTool(tool),
    // tool.key excluded: dedup on outbound payload+app, not alias/session key.
    tool.details,
    tool.state,
    largeImageKeyForTool(tool),
    SMALL_IMAGE_KEY
  ].join('|');
}

export async function clearConnectionActivity(clientId: string, state: RpcConnectionState): Promise<void> {
  state.activeToolKey = null;
  state.lastSentActivitySignature = null;
  cancelReconnect(state);

  if (!state.ready || !state.client) {
    state.lastCleared = true;
    return;
  }

  if (!state.lastCleared) {
    await state.client.clearActivity();
    state.lastCleared = true;
    log(`Cleared Discord activity for ${labelForClientId(clientId)}.`);
  }
}

async function updateActivityForClient(clientId: string, tool: ActiveTool): Promise<void> {
  const state = rpcStateForClientId(clientId);

  if (state.activeToolKey !== tool.key && getActivitySignature(tool) !== state.lastSentActivitySignature) {
    state.activeToolKey = tool.key;
    state.lastSentActivitySignature = null;
    state.lastCleared = false;
    log(`Detected ${tool.details || tool.key} for ${labelForClientId(clientId)}.`);
  }

  if ((!state.ready || !state.client) && Date.now() >= state.nextConnectAtMs) {
    await connectToDiscord(clientId);
  }

  if (!state.ready || !state.client) {
    return;
  }

  const signature = getActivitySignature(tool);
  if (signature === state.lastSentActivitySignature) {
    return;
  }

  await state.client.setActivity(buildPresence(tool));
  state.lastSentActivitySignature = signature;
  state.lastCleared = false;
  log(`Updated ${labelForClientId(clientId)} activity: ${tool.details || '(app name only)'}.`);
}

function sourceRank(tool: ActiveTool): number {
  return tool.source === 'hook' ? 1 : 0;
}

/**
 * Picks the one session Discord will show.
 *
 * Hook reports win over process detection regardless of timestamps. Process
 * tools are re-stamped with `Date.now()` on every poll, so comparing the two by
 * time alone let any long-lived background process (an `opencode serve`, a
 * codex CLI idling in a tab) permanently outrank the session the user is
 * actually typing in. Stale hook sessions cannot block forever: they are pruned
 * from the state file after `STATE_MAX_AGE_MS`.
 */


// Within one family the desktop app wins, unless the user is working in that
// tool's CLI right now (a terminal owns the foreground).
function pickSurface(familyTools: ActiveTool[], preferredSurface: 'app' | 'cli' | null): ActiveTool | undefined {
  if (preferredSurface === 'cli') {
    return familyTools.find((tool) => !isAppSurface(tool)) || familyTools[0];
  }
  return familyTools.find((tool) => isAppSurface(tool)) || familyTools[0];
}

// Default priority when nothing is focused or remembered (`preferredFamily`
// is null or exited): Claude Code/Desktop -> Codex -> Antigravity -> whatever
// else is currently active -> null (nothing; Discord shows any running game).
const FALLBACK_FAMILY_PRIORITY = ['claude', 'codex', 'antigravity'] as const;

export function selectNewestTool(
  tools: ActiveTool[],
  preferredFamily: string | null = null,
  preferredSurface: 'app' | 'cli' | null = null
): ActiveTool | null {
  if (!tools.length) {
    return null;
  }

  const ordered = [...tools].sort((left, right) => {
    const sourceDelta = sourceRank(right) - sourceRank(left);
    if (sourceDelta !== 0) {
      return sourceDelta;
    }

    const leftTime = coerceStateTimestamp(left.updatedAt) || 0;
    const rightTime = coerceStateTimestamp(right.updatedAt) || 0;
    return rightTime - leftTime;
  });

  // The foreground (or last-focused) window wins: stay on the last tool the
  // user actively entered instead of letting a background tool take over.
  const inFamily = (family: string) => ordered.filter((tool) => toolFamilyForTool(tool) === family);

  if (preferredFamily) {
    const foreground = pickSurface(inFamily(preferredFamily), preferredSurface);
    if (foreground) {
      return foreground;
    }
  }

  // With no active focus or remembered family (including after the remembered
  // tool exits), fall back in priority order: Claude -> Codex -> Antigravity
  // -> any other live tool.
  for (const family of FALLBACK_FAMILY_PRIORITY) {
    const candidate = pickSurface(inFamily(family), null);
    if (candidate) {
      return candidate;
    }
  }

  return pickSurface(inFamily(toolFamilyForTool(ordered[0])), null) || ordered[0];
}

export async function updateActivities(
  tools: ActiveTool[],
  preferredFamily: string | null = null,
  preferredSurface: 'app' | 'cli' | null = null
): Promise<void> {
  // Tools without a Discord application ID cannot display anything; excluding
  // them here (instead of selecting them) keeps a configured tool visible
  // instead of blanking Discord.
  const displayable = tools.filter((tool) => clientIdForTool(tool));
  const newest = selectNewestTool(displayable, preferredFamily, preferredSurface);
  const newestClientId = newest ? clientIdForTool(newest) : null;

  if (!newest || !newestClientId) {
    for (const [clientId, state] of rpcConnections) {
      await clearConnectionActivity(clientId, state);
    }
    return;
  }

  // Publish the new target BEFORE clearing the previous app: clearing first
  // blanks Discord whenever the new connection is not ready yet. When the new
  // target cannot publish (Discord down/connecting), the previous activity is
  // retained and the next pass retries. No invented rate limit is applied;
  // rapid events are coalesced by the caller and RPC errors/backpressure are
  // respected by leaving the signature unset for retry.
  await updateActivityForClient(newestClientId, newest);

  const published = rpcStateForClientId(newestClientId);
  if (!published.ready || published.lastSentActivitySignature === null) {
    debugLog(`Retaining previous activity; ${labelForClientId(newestClientId)} is not ready yet.`);
    return;
  }

  for (const [clientId, state] of rpcConnections) {
    if (clientId !== newestClientId) {
      await clearConnectionActivity(clientId, state);
    }
  }
}

export async function updateActivity(tool: ActiveTool | null, preferredFamily: string | null = null): Promise<void> {
  await updateActivities(tool ? [tool] : [], preferredFamily);
}
