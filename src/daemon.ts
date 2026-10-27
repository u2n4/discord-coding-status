'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  detectActiveTools
} from './core/detection/active-tools';
import {
  rememberLastFocusedFamily
} from './core/selection/last-focused';
import {
  getProcessList
} from './adapters/system/processes';
import {
  getCachedProcessByPid,
  getCachedProcessList,
  refreshProcessForPid,
  setCachedProcessList
} from './adapters/system/process-cache';
import {
  getForegroundWatcherStats,
  isForegroundWatchEnabled,
  isForegroundWatcherHealthy,
  startForegroundWatcher,
  stopForegroundWatcher
} from './adapters/system/foreground-watch';
import {
  getWatchedModelFile,
  unwatchSelectedModelFile,
  watchSelectedModelFile
} from './adapters/system/selected-model-watch';
import {
  applyClaudeDesktopDisplayOverride,
  clearVerifiedClaudeDesktopModel,
  getClaudeDesktopModelWatcherStats,
  getVerifiedClaudeDesktopModel,
  isClaudeDesktopModelWatcherHealthy,
  setVerifiedClaudeDesktopModel,
  startClaudeDesktopModelWatcher,
  stopClaudeDesktopModelWatcher
} from './adapters/system/claude-desktop-model-watch';
import type { ClaudeDesktopDisplayOverride } from './adapters/system/claude-desktop-model-watch';
import {
  toolProviders
} from './providers/registry';
import {
  readMuseExecModelForProcess
} from './providers/muse/model';
import {
  APP_TITLE,
  DETAIL_LEVEL,
  DISCORD_APPLICATIONS,
  FALLBACK_CLIENT_ID,
  POLL_INTERVAL_MS,
  PREFER_CODEX_CLI,
  PROCESS_ACTIVE_CPU_MS,
  PROCESS_DETECTION_ENABLED,
  PROCESS_IDLE_GRACE_MS,
  STATE_FILE,
  STATE_MAX_AGE_MS,
  STATE_WATCH_DEBOUNCE_MS,
  danger,
  dim,
  logError
} from './env';
import {
  cancelReconnect,
  clientIdForTool,
  detectStateTools,
  enrichToolsForPresence,
  labelForClientId,
  markShuttingDown,
  mergeActiveTools,
  rpcConnections,
  selectNewestTool,
  setRpcReadyKick,
  updateActivities
} from './presence';
import {
  registerUsageRefreshKick,
  toolFamilyForTool
} from './quota';
import {
  familyForForegroundProcess,
  getForegroundPid
} from './adapters/system/foreground';
import {
  debugLog,
  log
} from './state-store';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let stateWatcher: import('node:fs').FSWatcher | null = null;
let stateWatchTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

// Slow health census (10s) replaces the cached snapshot; fast focus/hook/model
// passes read the cache and never run a full census. Generations coalesce
// rapid events so a stale A is never republished after B.
let slowInFlight = false;
let fastInFlight = false;
let fastQueued = false;
let fastGeneration = 0;

let foregroundWatcherStarted = false;
let watcherRestartTimer: ReturnType<typeof setTimeout> | null = null;
let lastWatcherRestartAt = 0;
let latestForegroundPid: number | null | undefined = undefined;
let lastForegroundPid: number | null | undefined = undefined;
let claudeDesktopWatcherStarted = false;
let claudeDesktopExpectedPid: number | null = null;
let claudeDesktopWatcherRestartTimer: ReturnType<typeof setTimeout> | null = null;

setRpcReadyKick(() => {
  requestFastUpdate('rpc-ready');
});

registerUsageRefreshKick(() => {
  if (!shuttingDown) {
    requestFastUpdate('usage-refresh');
  }
});

function validateEnvironment(): void {
  const ids = [
    ...[...DISCORD_APPLICATIONS.values()].map(
      (application) => [application.clientIdEnvironment, application.clientId] as const
    ),
    ['DISCORD_CLIENT_ID', FALLBACK_CLIENT_ID] as const
  ];

  for (const [name, value] of ids) {
    if (!value) {
      if (name === 'DISCORD_CLIENT_ID'
        || name.endsWith('CURSOR_CLIENT_ID')
        || name.endsWith('MUSE_CLIENT_ID')) {
        continue;
      }

      console.error(danger(`Missing ${name}.`));
      process.exit(1);
    }

    if (!/^\d{10,32}$/.test(value)) {
      console.error(danger(`${name} does not look like a Discord Application ID.`));
      console.error(dim('Expected a numeric client ID, not a bot token, client secret, or application name.'));
      process.exit(1);
    }
  }
}

const DAEMON_LOCK_FILE = `${STATE_FILE}.daemon.lock`;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function readLockPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(DAEMON_LOCK_FILE, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

// Prevents duplicate daemon instances (a second manual start, or a task
// restart racing a slow shutdown). Stale locks from crashed daemons are
// taken over once their PID is gone.
function acquireDaemonLock(): boolean {
  const existingPid = readLockPid();
  if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
    return false;
  }

  try {
    fs.mkdirSync(path.dirname(DAEMON_LOCK_FILE), { recursive: true });
    fs.writeFileSync(DAEMON_LOCK_FILE, String(process.pid));
    return true;
  } catch (error) {
    logError('Could not write the daemon lock file; starting without duplicate protection', error);
    return true;
  }
}

function releaseDaemonLock(): void {
  try {
    if (readLockPid() === process.pid) {
      fs.unlinkSync(DAEMON_LOCK_FILE);
    }
  } catch (_) {
    // Best effort cleanup.
  }
}

function requestFastUpdate(reason: string): void {
  if (shuttingDown) {
    return;
  }

  if (fastInFlight) {
    fastQueued = true;
    debugLog(`Fast update queued (${reason}).`);
    return;
  }

  void runFastLoopOnce();
}

async function runSlowCensusOnce(): Promise<void> {
  if (slowInFlight || shuttingDown) {
    return;
  }

  slowInFlight = true;

  try {
    const processList = PROCESS_DETECTION_ENABLED ? await getProcessList() : [];
    setCachedProcessList(processList);
    debugLog(`Slow census cached ${processList.length} process(es).`);
    requestFastUpdate('slow-census');
  } catch (error) {
    logError('Slow census failed; continuing with the cached snapshot', error);
  } finally {
    slowInFlight = false;
  }
}

function getWatcherForegroundPid(): number | null | undefined {
  if (!isForegroundWatcherHealthy()) {
    return undefined;
  }

  return latestForegroundPid;
}

function updateSelectedModelWatch(
  activeTools: Parameters<typeof selectNewestTool>[0],
  effectivePreferred: string | null
): void {
  try {
    const displayable = activeTools.filter((tool) => clientIdForTool(tool));
    const selected = selectNewestTool(displayable, effectivePreferred);
    let file: string | null = null;

    // Only the positively bound headless exec file is ever watched. Bare TUI,
    // ambiguous, and unbound tools stay unwatched: no global inference.
    if (selected
      && selected.source === 'process'
      && selected.family === 'muse'
      && !selected.processAmbiguous
      && selected.processInfo) {
      try {
        file = readMuseExecModelForProcess(selected.processInfo)?.sessionFile || null;
      } catch (_) {
        file = null;
      }
    }

    if (file !== getWatchedModelFile()) {
      if (file) {
        watchSelectedModelFile(file, () => requestFastUpdate('model-file'));
        debugLog(`Watching selected Muse model file ${file}.`);
      } else {
        unwatchSelectedModelFile();
      }
    }
  } catch (error) {
    debugLog(`Selected-model watch update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function claudeDesktopProviderMatchesPid(pid: number): boolean {
  // Positive process/package binding via the registered Claude App provider
  // (Store/known-install + exact Claude.exe). No version/path hardcoding.
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  const proc = getCachedProcessByPid(pid);
  if (!proc) {
    return false;
  }
  const desktop = toolProviders.find((provider) => provider.id === 'claudeApp');
  const matches = desktop?.process?.matches;
  if (!matches) {
    return false;
  }
  try {
    return matches(proc);
  } catch (_) {
    return false;
  }
}

function getVerifiedDesktopModelForDisplay(): string | null {
  // Retention policy: a verified UI model stays displayable while its PID is
  // still a live Claude Desktop process and the observation is fresh. Fail
  // closed otherwise (caller clears stale entries).
  const cached = getVerifiedClaudeDesktopModel();
  if (!cached) {
    return null;
  }
  if (!Number.isFinite(cached.updatedAt) || Date.now() - cached.updatedAt > STATE_MAX_AGE_MS) {
    return null;
  }
  if (!claudeDesktopProviderMatchesPid(cached.pid)) {
    return null;
  }
  return cached.model;
}

function stopClaudeDesktopModelTracker(): void {
  if (claudeDesktopWatcherRestartTimer) {
    clearTimeout(claudeDesktopWatcherRestartTimer);
    claudeDesktopWatcherRestartTimer = null;
  }
  try {
    stopClaudeDesktopModelWatcher();
  } catch (error) {
    debugLog(`Claude Desktop model watcher stop failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  claudeDesktopWatcherStarted = false;
  claudeDesktopExpectedPid = null;
}

function ensureClaudeDesktopModelTracker(expectedPid: number | null): void {
  // Bounded lifecycle: the helper runs ONLY while a Desktop PID is the
  // current foreground target. Window/PID change restarts it; leaving
  // Desktop stops it (retention continues via the verified cache, no live
  // queries in the background). Inert when process detection is off,
  // non-Windows, or shutting down.
  if (shuttingDown || process.platform !== 'win32' || !PROCESS_DETECTION_ENABLED) {
    if (claudeDesktopWatcherStarted || claudeDesktopExpectedPid !== null) {
      stopClaudeDesktopModelTracker();
    }
    return;
  }
  if (typeof expectedPid !== 'number' || !Number.isFinite(expectedPid) || expectedPid <= 0) {
    if (claudeDesktopWatcherStarted) {
      stopClaudeDesktopModelTracker();
    }
    claudeDesktopExpectedPid = null;
    return;
  }
  if (!claudeDesktopProviderMatchesPid(expectedPid)) {
    if (claudeDesktopWatcherStarted) {
      stopClaudeDesktopModelTracker();
    }
    claudeDesktopExpectedPid = null;
    return;
  }
  if (claudeDesktopWatcherStarted && claudeDesktopExpectedPid === expectedPid && isClaudeDesktopModelWatcherHealthy()) {
    return;
  }
  claudeDesktopExpectedPid = expectedPid;
  claudeDesktopWatcherStarted = true;
  const handle = startClaudeDesktopModelWatcher(
    (event) => {
      if (event.kind === 'model') {
        try {
          setVerifiedClaudeDesktopModel(expectedPid, event.model);
        } catch (_) {
          // Cache writes are best effort; the helper re-emits on change.
        }
        debugLog('Claude Desktop model updated.');
        requestFastUpdate('desktop-model');
        return;
      }
      if (event.kind === 'unavailable') {
        // Foreground matches but the selector failed: fail closed to
        // app-only (clear stale) and republish without the model.
        clearVerifiedClaudeDesktopModel();
        debugLog('Claude Desktop model unavailable; failing closed to app-only.');
        requestFastUpdate('desktop-model-unavailable');
        return;
      }
      // UNBOUND means focus left the expected window; the foreground sampler
      // already queued a fast pass for the PID change, so no extra update.
      // Retention vs clear is decided in the fast pass by foreground family.
    },
    () => {
      debugLog('Claude Desktop model watcher exited.');
      claudeDesktopWatcherStarted = false;
      if (!shuttingDown && claudeDesktopExpectedPid !== null) {
        if (claudeDesktopWatcherRestartTimer) {
          clearTimeout(claudeDesktopWatcherRestartTimer);
        }
        claudeDesktopWatcherRestartTimer = setTimeout(() => {
          claudeDesktopWatcherRestartTimer = null;
          if (!shuttingDown && claudeDesktopExpectedPid !== null) {
            claudeDesktopWatcherStarted = false;
            ensureClaudeDesktopModelTracker(claudeDesktopExpectedPid);
            requestFastUpdate('desktop-watcher-restart');
          }
        }, 1000);
        (claudeDesktopWatcherRestartTimer as unknown as { unref?: () => void }).unref?.();
      }
    },
    { expectedPid }
  );
  if (handle) {
    const stats = getClaudeDesktopModelWatcherStats();
    debugLog(`Claude Desktop model watcher started (PID ${stats.pid}, target ${expectedPid}).`);
  } else {
    debugLog('Claude Desktop model watcher unavailable; Desktop stays app-only.');
    claudeDesktopWatcherStarted = false;
  }
}

async function runFastPass(generation: number): Promise<void> {
  const stateTools = detectStateTools();
  const cachedSnapshot = getCachedProcessList();
  const processTools = PROCESS_DETECTION_ENABLED
    ? detectActiveTools(cachedSnapshot, toolProviders, {
      preferredSurfaceByFamily: PREFER_CODEX_CLI ? { codex: 'cli' } : {},
      idleGraceMs: PROCESS_IDLE_GRACE_MS,
      activeCpuMs: PROCESS_ACTIVE_CPU_MS
    })
    : [];
  debugLog(`Fast pass ${generation} found ${stateTools.length} state tool(s) and ${processTools.length} process tool(s).`);
  const merged = mergeActiveTools(stateTools, processTools);
  const displayable = merged.filter((tool) => clientIdForTool(tool));
  const aliveFamilies = new Set(displayable.map((tool) => toolFamilyForTool(tool)));

  // Foreground attribution only runs while several displayable tools compete,
  // so the common single-tool case costs no extra work. Unknown/null/browser/
  // game foreground keeps the remembered family via last-focused retention.
  // Hook-only mode (PROCESS_DETECTION=off) has no PID attribution: skip the
  // watcher/oneshot census entirely so hook tests stay deterministic and never
  // inherit the real user foreground; newest-hook wins when no AI focus exists.
  let currentForegroundFamily: string | null = null;
  if (PROCESS_DETECTION_ENABLED && displayable.length >= 2) {
    let foregroundPid = getWatcherForegroundPid();

    if (foregroundPid === undefined) {
      // Watcher has no data yet or is unavailable: single oneshot fallback,
      // never a second persistent helper while healthy.
      try {
        foregroundPid = await getForegroundPid();
      } catch (_) {
        foregroundPid = null;
      }
    }

    if (typeof foregroundPid === 'number' && foregroundPid > 0) {
      if (!getCachedProcessByPid(foregroundPid)) {
        try {
          await refreshProcessForPid(foregroundPid);
        } catch (error) {
          debugLog(`Foreground refresh failed for ${foregroundPid}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      currentForegroundFamily = familyForForegroundProcess(
        foregroundPid,
        getCachedProcessList(),
        toolProviders
      );
    }
  }

  const effectivePreferred = rememberLastFocusedFamily(currentForegroundFamily, aliveFamilies);

  // A newer event arrived while this pass was working: abort before any RPC
  // write so stale A is never republished after B. The queued pass reruns
  // with the latest focus/state.
  if (fastQueued && !shuttingDown) {
    debugLog(`Fast pass ${generation} aborted before enrich (newer event queued).`);
    return;
  }

  // Narrow Claude Desktop binding: resolve the foreground PID for Desktop
  // model tracking even when a single tool is displayable (the competing
  // block above is skipped then). Reuses the watcher/oneshot cache; never a
  // second persistent helper and never a per-tick census.
  let desktopOverride: ClaudeDesktopDisplayOverride = null;
  const claudeDisplayable = displayable.some((tool) => toolFamilyForTool(tool) === 'claude');
  if (PROCESS_DETECTION_ENABLED && claudeDisplayable) {
    let desktopFgPid = getWatcherForegroundPid();
    if (desktopFgPid === undefined) {
      try {
        desktopFgPid = await getForegroundPid();
      } catch (_) {
        desktopFgPid = null;
      }
    }
    let desktopFgFamily: string | null = null;
    if (typeof desktopFgPid === 'number' && desktopFgPid > 0) {
      if (!getCachedProcessByPid(desktopFgPid)) {
        try {
          await refreshProcessForPid(desktopFgPid);
        } catch (error) {
          debugLog(`Desktop foreground refresh failed for ${desktopFgPid}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      desktopFgFamily = familyForForegroundProcess(desktopFgPid, getCachedProcessList(), toolProviders);
    }
    const desktopFgIsDesktop = typeof desktopFgPid === 'number' && desktopFgPid > 0 && claudeDesktopProviderMatchesPid(desktopFgPid);
    if (desktopFgIsDesktop && typeof desktopFgPid === 'number') {
      ensureClaudeDesktopModelTracker(desktopFgPid);
      const verified = getVerifiedDesktopModelForDisplay();
      if (verified && getVerifiedClaudeDesktopModel()?.pid === desktopFgPid) {
        desktopOverride = { kind: 'model', model: verified };
      } else {
        // Desktop foreground without a verified model: fail closed to
        // app-only so a stale background CLI label is never attached.
        desktopOverride = { kind: 'app-only' };
      }
    } else {
      ensureClaudeDesktopModelTracker(null);
      if (desktopFgFamily === 'claude') {
        // CLI foreground (same family, competing surface): clear a stale
        // Desktop label so a later Discord focus retains CLI, not Desktop.
        clearVerifiedClaudeDesktopModel();
        desktopOverride = null;
      } else if (desktopFgFamily === null) {
        // Non-AI/unknown foreground (Discord/browser/plain terminal): retain
        // the last verified Desktop model while its PID stays alive, fresh,
        // and package-bound. Other-AI foreground takes the no-override path
        // below (that AI displays; the Desktop cache stays parked).
        const retained = getVerifiedDesktopModelForDisplay();
        if (retained) {
          desktopOverride = { kind: 'model', model: retained };
        } else {
          clearVerifiedClaudeDesktopModel();
          desktopOverride = null;
        }
      } else {
        desktopOverride = null;
      }
    }
  } else {
    ensureClaudeDesktopModelTracker(null);
  }

  const activeTools = await enrichToolsForPresence(merged);

  if (fastQueued && !shuttingDown) {
    debugLog(`Fast pass ${generation} aborted before publish (newer event queued).`);
    return;
  }

  const withDesktop = desktopOverride ? applyClaudeDesktopDisplayOverride(activeTools, desktopOverride) : activeTools;

  await updateActivities(withDesktop, effectivePreferred);
  updateSelectedModelWatch(withDesktop, effectivePreferred);
}

async function runFastLoopOnce(): Promise<void> {
  if (fastInFlight) {
    fastQueued = true;
    return;
  }

  fastInFlight = true;

  try {
    do {
      fastQueued = false;
      fastGeneration += 1;
      const generation = fastGeneration;

      try {
        await runFastPass(generation);
      } catch (error) {
        logError('Fast pass failed; continuing', error);
      }
    } while (fastQueued && !shuttingDown);
  } finally {
    fastInFlight = false;
  }
}

function scheduleWatcherRestart(): void {
  if (shuttingDown || !foregroundWatcherStarted || watcherRestartTimer) {
    return;
  }

  const delay = Math.max(0, 1000 - (Date.now() - lastWatcherRestartAt));
  watcherRestartTimer = setTimeout(() => {
    watcherRestartTimer = null;
    if (shuttingDown) {
      return;
    }

    lastWatcherRestartAt = Date.now();
    try {
      stopForegroundWatcher();
    } catch (_) {
      // Best effort cleanup before restarting the singleton.
    }
    foregroundWatcherStarted = false;
    startForegroundWatcherIfNeeded();
    requestFastUpdate('watcher-restart');
  }, delay);
}

function startForegroundWatcherIfNeeded(): void {
  if (foregroundWatcherStarted || shuttingDown) {
    return;
  }

  if (process.platform !== 'win32') {
    return;
  }

  if (!PROCESS_DETECTION_ENABLED) {
    debugLog('Foreground watcher disabled (process detection off).');
    return;
  }

  if (!isForegroundWatchEnabled()) {
    debugLog('Foreground watcher disabled via DISCORD_CODING_STATUS_FOREGROUND_WATCH.');
    return;
  }

  foregroundWatcherStarted = true;
  latestForegroundPid = undefined;
  lastForegroundPid = undefined;

  const handle = startForegroundWatcher(
    (pid: number | null) => {
      if (pid === lastForegroundPid) {
        return;
      }

      lastForegroundPid = pid;
      latestForegroundPid = pid;
      debugLog(`Foreground PID changed to ${pid === null ? 'unknown' : pid}.`);
      requestFastUpdate('foreground');
    },
    () => {
      debugLog('Foreground watcher exited; using oneshot fallback until restart.');
      latestForegroundPid = undefined;
      scheduleWatcherRestart();
    }
  );

  if (handle) {
    const stats = getForegroundWatcherStats();
    log(`Foreground watcher started (PID ${stats.pid}, ${stats.sampleMs}ms sampler).`);
  } else {
    debugLog('Foreground watcher unavailable; using oneshot fallback.');
    foregroundWatcherStarted = false;
  }
}

function stopForegroundWatcherIfNeeded(): void {
  if (watcherRestartTimer) {
    clearTimeout(watcherRestartTimer);
    watcherRestartTimer = null;
  }

  try {
    stopForegroundWatcher();
  } catch (error) {
    debugLog(`Foreground watcher stop failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  foregroundWatcherStarted = false;
  latestForegroundPid = undefined;
  lastForegroundPid = undefined;
}

function stopStateWatcher(): void {
  if (stateWatchTimer) {
    clearTimeout(stateWatchTimer);
    stateWatchTimer = null;
  }

  if (stateWatcher) {
    stateWatcher.close();
    stateWatcher = null;
  }
}

function startStateWatcher(): void {
  if (stateWatcher) {
    return;
  }

  const stateDirectory = path.dirname(STATE_FILE);
  const stateFilename = path.basename(STATE_FILE);
  fs.mkdirSync(stateDirectory, { recursive: true });

  try {
    const watcher = fs.watch(
      stateDirectory,
      (_eventType: string, filename: string | Buffer | null) => {
        if (shuttingDown || (filename && filename.toString() !== stateFilename)) {
          return;
        }

        if (stateWatchTimer) {
          clearTimeout(stateWatchTimer);
        }

        stateWatchTimer = setTimeout(() => {
          stateWatchTimer = null;
          requestFastUpdate('hook');
        }, STATE_WATCH_DEBOUNCE_MS);
      }
    );
    stateWatcher = watcher;
    log(`Watching ${STATE_FILE} for hook updates.`);

    watcher.on('error', (error: unknown) => {
      logError('State file watcher failed; polling will continue', error);
      stopStateWatcher();
    });
  } catch (error) {
    logError('Could not watch the state file; polling will continue', error);
    stopStateWatcher();
  }
}

function startPolling(): void {
  if (pollTimer) {
    return;
  }

  startStateWatcher();
  startForegroundWatcherIfNeeded();
  pollTimer = setInterval(() => {
    void runSlowCensusOnce();
  }, POLL_INTERVAL_MS);
  // Fast init renders hook tools immediately; the slow census then populates
  // the process cache and triggers a second fast pass with full data.
  requestFastUpdate('init');
  void runSlowCensusOnce();
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  markShuttingDown();
  releaseDaemonLock();
  log(`Received ${signal}. Shutting down.`);

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopStateWatcher();
  stopForegroundWatcherIfNeeded();
  stopClaudeDesktopModelTracker();

  try {
    unwatchSelectedModelFile();
  } catch (_) {
    // Best effort cleanup.
  }

  for (const state of rpcConnections.values()) {
    cancelReconnect(state);
  }

  for (const [clientId, state] of rpcConnections) {
    try {
      if (state.ready && state.client) {
        await state.client.clearActivity();
        log(`Cleared Discord activity for ${labelForClientId(clientId)}.`);
      }
    } catch (error) {
      logError(`Failed to clear ${labelForClientId(clientId)} activity during shutdown`, error);
    }
  }

  for (const state of rpcConnections.values()) {
    try {
      if (state.client) {
        state.client.destroy();
      }
    } catch (_) {
      // Ignore shutdown cleanup errors.
    }
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  logError('Unhandled promise rejection', error);
});
process.on('uncaughtException', (error) => {
  logError('Uncaught exception', error);
});

export function startDaemon(): void {
  validateEnvironment();
  if (!acquireDaemonLock()) {
    log('Another daemon instance is already running. Exiting.');
    process.exit(0);
  }
  log(`Starting ${APP_TITLE} daemon.`);
  log(`Presence detail level: ${DETAIL_LEVEL}.`);
  startPolling();
}
