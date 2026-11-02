'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import DiscordRPC from 'discord-rpc';
import {
  DISCORD_APPLICATIONS,
  LARGE_IMAGE_KEY,
  SMALL_IMAGE_KEY,
  FALLBACK_CLIENT_ID,
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
import { readMuseExecModelForProcess, readMuseSettingsModel } from './providers/muse/model';
import { readCodexConfiguredModel } from './providers/codex/model';
import { readGrokDefaultConfigModel, readGrokSessionSummaryModel } from './providers/grok/model';
import { readActiveAntigravityModel } from './providers/antigravity/model';
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
    connectionAttempt: 0
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

function scheduleReconnect(clientId: string): void {
  const state = rpcStateForClientId(clientId);
  if (shuttingDown || state.reconnectTimer) {
    return;
  }

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connectToDiscord(clientId);
  }, RECONNECT_INTERVAL_MS);
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
        try {
          state.client.destroy();
        } catch (_) {
          // Best effort cleanup before creating a fresh IPC client.
        }
      }

      DiscordRPC.register(clientId);
      client = new DiscordRPC.Client({ transport: 'ipc' });
      state.client = client;

      client.on('ready', () => {
        if (attemptId !== state.connectionAttempt || client !== state.client) {
          return;
        }

        state.ready = true;
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
        try {
          client.destroy();
        } catch (_) {
          // Best effort cleanup before retrying.
        }

        state.client = null;
      }

      state.ready = false;
      logError(`Could not connect to Discord RPC for ${labelForClientId(clientId)}. Is Discord Desktop running?`, error);
      scheduleReconnect(clientId);
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
      claudeQuotaEligible: session.claude_quota_eligible ?? null
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
      packageName: session.package || null
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

export function detectStateTools(): ActiveTool[] {
  const state = cleanupStateSessions(readStateFile(), Date.now());
  const sessions = Object.values(state.sessions);
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

  for (const tool of [...primary, ...fallback]) {
    const key = familyKeyForTool(tool);

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
  // Raw model id only: reasoning effort and every other enrichment are
  // intentionally excluded from the minimal display contract.
  const model = String(tool.model || '').replace(/\s+/g, ' ').trim();
  return model ? truncatePresenceText(model) : null;
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

export async function enrichToolForPresence(tool: ActiveTool | null): Promise<ActiveTool | null> {
  if (!tool) {
    return null;
  }

  // Minimal display contract: the Discord application identity already shows
  // the tool name ("Playing Codex"), so the only published line is the raw
  // model id. No activity, project, branch, quota, context, package, emoji,
  // session counts, or timestamps are ever sent to Discord.
  let model = modelTextForPresence(tool);
  const updatedAtMs = coerceStateTimestamp(tool.updatedAt) || 0;

  if (tool.family === 'codex') {
    const configured = readCodexConfiguredModel();
    if (configured?.model) {
      if (tool.source === 'hook' && (!model || (updatedAtMs > 0 && configured.mtimeMs > updatedAtMs))) {
        model = truncatePresenceText(configured.model);
      } else if (tool.source === 'process' && !model && isVerifiedLiveProcess(tool.processInfo)) {
        model = truncatePresenceText(configured.model);
      }
    }
  } else if (tool.family === 'grok') {
    if (tool.sessionId) {
      const summary = readGrokSessionSummaryModel(tool.sessionId, tool.cwd);
      if (summary?.model && (!model || (updatedAtMs > 0 && summary.mtimeMs > updatedAtMs))) {
        model = truncatePresenceText(summary.model);
      }
    }
    if (!model && tool.source === 'process' && isVerifiedLiveProcess(tool.processInfo)) {
      const configured = readGrokDefaultConfigModel();
      if (configured?.model) {
        model = truncatePresenceText(configured.model);
      }
    }
  } else if (tool.family === 'muse') {
    if (!model && tool.source === 'process' && !tool.processAmbiguous && tool.processInfo) {
      let resolved: string | null = null;
      try {
        resolved = readMuseExecModelForProcess(tool.processInfo)?.model || null;
      } catch (_) {
        resolved = null;
      }
      if (resolved) {
        model = truncatePresenceText(resolved);
      }
    }
    const settings = readMuseSettingsModel();
    if (settings?.model) {
      if (tool.source === 'hook' && (!model || (updatedAtMs > 0 && settings.mtimeMs > updatedAtMs))) {
        model = truncatePresenceText(settings.model);
      } else if (tool.source === 'process' && !model && !tool.processAmbiguous && isVerifiedLiveProcess(tool.processInfo)) {
        model = truncatePresenceText(settings.model);
      }
    }
  }
  let nextUpdatedAt = tool.updatedAt;
  let nextSource = tool.source;
  if (tool.family === 'antigravity') {
    const active = readActiveAntigravityModel();
    if (active?.model) {
      model = truncatePresenceText(active.model);
    }
    if (
      active
      && Date.now() - active.mtimeMs <= 15 * 60_000
      && tool.source === 'process'
      && isVerifiedLiveProcess(tool.processInfo)
    ) {
      nextSource = 'hook';
      nextUpdatedAt = Math.floor(active.mtimeMs);
    }
  }

  return {
    ...tool,
    ...(nextSource !== tool.source ? { source: nextSource } : {}),
    ...(nextUpdatedAt !== tool.updatedAt ? { updatedAt: nextUpdatedAt } : {}),
    details: model ? truncatePresenceText(`Model: ${model}`) : '',
    state: ''
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

  if (!state.ready || !state.client) {
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
export function selectNewestTool(tools: ActiveTool[], preferredFamily: string | null = null): ActiveTool | null {
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

  // The foreground window wins: when the user is actively working in one of
  // the detected tools, that tool is shown even if another tool reported a
  // hook session more recently.
  if (preferredFamily) {
    const foreground = ordered.find((tool) => toolFamilyForTool(tool) === preferredFamily);
    if (foreground) {
      return foreground;
    }
  }

  if (toolFamilyForTool(ordered[0]) === 'codex') {
    const topRank = sourceRank(ordered[0]);
    const claudeTool = ordered.find(
      (tool) => toolFamilyForTool(tool) === 'claude' && sourceRank(tool) >= topRank
    );
    if (claudeTool) {
      return claudeTool;
    }
  }

  return ordered[0];
}

export async function updateActivities(tools: ActiveTool[], preferredFamily: string | null = null): Promise<void> {
  // Tools without a Discord application ID cannot display anything; excluding
  // them here (instead of selecting them) keeps a configured tool visible
  // instead of blanking Discord.
  const displayable = tools.filter((tool) => clientIdForTool(tool));
  const newest = selectNewestTool(displayable, preferredFamily);
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
