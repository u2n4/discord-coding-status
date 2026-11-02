'use strict';

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  detectActiveTools
} from './core/detection/active-tools';
import {
  rememberLastFocusedFamily
} from './core/selection/last-focused';
import {
  applyMuseDisplayResolution,
  getRememberedMuseDisplaySession,
  isMuseHookBindingLive,
  rememberMuseDisplaySession,
  resolveMuseDisplaySession
} from './core/selection/muse-instance';
import {
  getProcessList,
  isProcessAlive
} from './adapters/system/processes';
import {
  getCachedProcessByPid,
  getCachedProcessList,
  isHostOrAiProcess,
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
  HELPER_RESTART_CAP_MS,
  HelperRestartBackoff,
  applyClaudeDesktopDisplayOverride,
  clearVerifiedClaudeDesktopModel,
  getClaudeDesktopModelWatcherStats,
  getVerifiedClaudeDesktopModel,
  isClaudeDesktopModelWatcherHealthy,
  isVerifiedClaudeDesktopModelFresh,
  setVerifiedClaudeDesktopModel,
  startClaudeDesktopModelWatcher,
  stopClaudeDesktopModelWatcher,
  touchVerifiedClaudeDesktopModel
} from './adapters/system/claude-desktop-model-watch';
import type {
  ClaudeDesktopDisplayOverride,
  VerifiedClaudeDesktopModel
} from './adapters/system/claude-desktop-model-watch';
import {
  toolProviders
} from './providers/registry';
import {
  readMuseExecModelForProcess,
  readMuseSettingsModel
} from './providers/muse/model';
import {
  readCodexConfiguredModel,
  readCodexDesktopModel
} from './providers/codex/model';
import {
  readGrokDefaultConfigModel,
  readGrokSessionSummaryModel
} from './providers/grok/model';
import {
  findActiveAntigravityTranscriptFile,
  getAntigravityStateFile,
  readActiveAntigravityModel
} from './providers/antigravity/model';
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
  destroyRpcClient,
  detectStateTools,
  enrichToolsForPresence,
  labelForClientId,
  markShuttingDown,
  mergeActiveTools,
  readLiveMuseHookSessions,
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
  familiesForForegroundProcess,
  getForegroundPid,
  musePidForForegroundProcess,
  pickAmbiguousForegroundFamily
} from './adapters/system/foreground';
import {
  debugLog,
  log
} from './state-store';

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollingStarted = false;
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
// Consecutive passes aborted because a newer event was queued. Constant hook
// writes would otherwise starve publishing forever; after this many aborts
// the pass publishes anyway (its data is at most one event old).
let consecutiveFastAborts = 0;
const MAX_CONSECUTIVE_FAST_ABORTS = 3;

// Adaptive slow census: while no AI tool process or hook session is alive the
// census runs at the idle interval; the first hook/process sighting switches
// back to POLL_INTERVAL_MS immediately.
export const IDLE_CENSUS_INTERVAL_MS = Math.max(POLL_INTERVAL_MS, 60_000);
let aiActivityAlive = true;
let censusMode: 'active' | 'idle' | null = null;

let foregroundWatcherStarted = false;
let watcherRestartTimer: ReturnType<typeof setTimeout> | null = null;
const foregroundWatcherBackoff = new HelperRestartBackoff();
let latestForegroundPid: number | null | undefined = undefined;
let lastForegroundPid: number | null | undefined = undefined;
let claudeDesktopWatcherStarted = false;
let claudeDesktopExpectedPid: number | null = null;
let claudeDesktopWatcherRestartTimer: ReturnType<typeof setTimeout> | null = null;
// UIA helper restart policy: backoff per Desktop PID, app-only after 5
// consecutive failures until the Desktop PID changes.
const CLAUDE_DESKTOP_HELPER_GIVE_UP_AFTER = 5;
const claudeDesktopBackoff = new HelperRestartBackoff(CLAUDE_DESKTOP_HELPER_GIVE_UP_AFTER);

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

export const DAEMON_LOCK_FILE = `${STATE_FILE}.daemon.lock`;

export interface DaemonLockInfo {
  pid: number;
  /** Lock acquisition time (ms); legacy PID-only locks use the file mtime. */
  startedAt: number | null;
  raw: string;
}

export interface DaemonProcessIdentity {
  name: string;
  commandLine: string;
  createdAtMs: number | null;
}

/** Clock-skew allowance between process creation and lock acquisition. */
const LOCK_CREATION_TOLERANCE_MS = 5_000;

export function readDaemonLock(lockFile: string = DAEMON_LOCK_FILE): DaemonLockInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockFile, 'utf8');
  } catch (_) {
    return null;
  }

  const text = raw.trim();
  let pid = NaN;
  let startedAt: number | null = null;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { pid?: unknown; startedAt?: unknown };
      pid = Number(parsed.pid);
      const started = Number(parsed.startedAt);
      startedAt = Number.isFinite(started) && started > 0 ? started : null;
    } catch (_) {
      pid = NaN;
    }
  } else {
    // Legacy lock (PID only) written by older daemons.
    pid = Number(text);
    try {
      startedAt = fs.statSync(lockFile).mtimeMs;
    } catch (_) {
      startedAt = null;
    }
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid: 0, startedAt: null, raw };
  }
  return { pid, startedAt, raw };
}

/**
 * One CIM lookup of a PID's identity (Windows). Returns undefined when the
 * query itself failed (unknown), null when no such process exists.
 */
export function queryDaemonProcessIdentity(pid: number): DaemonProcessIdentity | null | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }
  const safePid = Math.floor(pid);
  if (!Number.isFinite(safePid) || safePid <= 0) {
    return null;
  }
  const command = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${safePid}";`,
    'if ($p) { [pscustomobject]@{ Name = [string]$p.Name; CommandLine = [string]$p.CommandLine;',
    "Created = $(if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' }) } | ConvertTo-Json -Compress }"
  ].join(' ');
  let stdout: string;
  try {
    stdout = String(execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command
    ], { encoding: 'utf8', timeout: 5_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) || '');
  } catch (_) {
    return undefined;
  }
  const text = stdout.trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as { Name?: unknown; CommandLine?: unknown; Created?: unknown };
    const created = typeof parsed.Created === 'string' ? Date.parse(parsed.Created) : NaN;
    return {
      name: typeof parsed.Name === 'string' ? parsed.Name : '',
      commandLine: typeof parsed.CommandLine === 'string' ? parsed.CommandLine : '',
      createdAtMs: Number.isFinite(created) ? created : null
    };
  } catch (_) {
    return undefined;
  }
}

/** True when `identity` looks like this app's daemon (node/bun running `cli.js daemon`). */
export function isDaemonProcessIdentity(identity: DaemonProcessIdentity, lockStartedAt: number | null): boolean {
  if (!/^(?:node|bun)(?:\.exe)?$/i.test(identity.name.trim())) {
    return false;
  }
  if (!/cli\.js/i.test(identity.commandLine) || !/(?:^|\s|")daemon(?:\s|"|$)/i.test(identity.commandLine)) {
    return false;
  }
  // A process created after the lock was written reused the PID.
  if (lockStartedAt !== null && identity.createdAtMs !== null
    && identity.createdAtMs > lockStartedAt + LOCK_CREATION_TOLERANCE_MS) {
    return false;
  }
  return true;
}

/**
 * Whether the lock holder is a live instance of our daemon. A dead PID, or a
 * live PID that now belongs to an unrelated process (PID reuse), is stale.
 * When the identity lookup itself fails the holder is assumed live (never
 * start a duplicate on missing evidence).
 */
export function isDaemonLockHolderLive(
  lock: DaemonLockInfo,
  lookup: (pid: number) => DaemonProcessIdentity | null | undefined = queryDaemonProcessIdentity
): boolean {
  if (!lock.pid || !isProcessAlive(lock.pid)) {
    return false;
  }
  if (lock.pid === process.pid) {
    return true;
  }
  const identity = lookup(lock.pid);
  if (identity === undefined) {
    return true;
  }
  if (identity === null) {
    return false;
  }
  return isDaemonProcessIdentity(identity, lock.startedAt);
}

function unlinkIfLockContent(lockFile: string, expected: string): void {
  try {
    if (fs.readFileSync(lockFile, 'utf8') === expected) {
      fs.unlinkSync(lockFile);
    }
  } catch (_) {
    // Already gone or replaced: the next exclusive create decides.
  }
}

let ownDaemonLockContent: string | null = null;

// Prevents duplicate daemon instances (a second manual start, or a task
// restart racing a slow shutdown). The lock is created exclusively ('wx') so
// two starting daemons can never both win; a stale lock (dead PID, PID reused
// by another program, or a force-killed daemon) is removed and retried.
export function acquireDaemonLock(
  lockFile: string = DAEMON_LOCK_FILE,
  lookup?: (pid: number) => DaemonProcessIdentity | null | undefined
): boolean {
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  } catch (_) {
    // openSync below reports the real error.
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeFileSync(fd, content);
      } finally {
        fs.closeSync(fd);
      }
      ownDaemonLockContent = content;
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'EEXIST') {
        logError('Could not write the daemon lock file; starting without duplicate protection', error);
        return true;
      }
    }

    const existing = readDaemonLock(lockFile);
    if (!existing) {
      continue;
    }
    if (existing.raw.trim() === '') {
      // Another starter created the file and has not written it yet.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      const again = readDaemonLock(lockFile);
      if (!again || again.raw !== existing.raw) {
        continue;
      }
    }
    if (existing.pid && isDaemonLockHolderLive(existing, lookup)) {
      return false;
    }
    log(`Removing stale daemon lock (PID ${existing.pid || 'unknown'}).`);
    unlinkIfLockContent(lockFile, existing.raw);
  }

  return false;
}

export function releaseDaemonLock(lockFile: string = DAEMON_LOCK_FILE): void {
  if (ownDaemonLockContent !== null) {
    unlinkIfLockContent(lockFile, ownDaemonLockContent);
    ownDaemonLockContent = null;
  }
}

/**
 * Stops ONLY the daemon recorded in the lock file (verified identity), then
 * waits for it to exit so a following task /Run is not refused by the lock.
 * The hidden VBS launcher returns immediately, so `schtasks /End` alone never
 * stops the running daemon.
 */
export function stopDaemonFromLock(
  lockFile: string = DAEMON_LOCK_FILE,
  options: { timeoutMs?: number; lookup?: (pid: number) => DaemonProcessIdentity | null | undefined } = {}
): 'none' | 'stale' | 'stopped' | 'still-running' {
  const lock = readDaemonLock(lockFile);
  if (!lock || !lock.pid || lock.pid === process.pid) {
    return 'none';
  }
  if (!isDaemonLockHolderLive(lock, options.lookup)) {
    return 'stale';
  }
  try {
    process.kill(lock.pid);
  } catch (_) {
    // Exited between the check and the kill.
  }
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    if (!isProcessAlive(lock.pid)) {
      return 'stopped';
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return isProcessAlive(lock.pid) ? 'still-running' : 'stopped';
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
    aiActivityAlive = hasLiveAiActivity(processList);
    requestFastUpdate('slow-census');
  } catch (error) {
    logError('Slow census failed; continuing with the cached snapshot', error);
  } finally {
    slowInFlight = false;
    scheduleNextCensus();
  }
}

function hasLiveAiActivity(processList: Parameters<typeof detectActiveTools>[0]): boolean {
  try {
    if (detectStateTools().length > 0) {
      return true;
    }
    return PROCESS_DETECTION_ENABLED && detectActiveTools(processList, toolProviders, {
      preferredSurfaceByFamily: PREFER_CODEX_CLI ? { codex: 'cli' } : {},
      idleGraceMs: PROCESS_IDLE_GRACE_MS,
      activeCpuMs: PROCESS_ACTIVE_CPU_MS
    }).length > 0;
  } catch (_) {
    return true;
  }
}

function scheduleNextCensus(delayOverride?: number): void {
  if (shuttingDown || !pollingStarted) {
    return;
  }
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  const mode: 'active' | 'idle' = aiActivityAlive ? 'active' : 'idle';
  const delay = delayOverride ?? (mode === 'active' ? POLL_INTERVAL_MS : IDLE_CENSUS_INTERVAL_MS);
  if (mode !== censusMode) {
    censusMode = mode;
    debugLog(`Slow census ${mode}; next in ${delay}ms.`);
  }
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void runSlowCensusOnce();
  }, delay);
}

// A hook or process sighting while idle switches the census back to the
// active interval at once (one immediate census refreshes process data).
function noteAiActivity(alive: boolean): void {
  if (alive && !aiActivityAlive) {
    aiActivityAlive = true;
    if (!slowInFlight) {
      scheduleNextCensus(0);
    }
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

    if (selected) {
      if (selected.family === 'muse') {
        if (selected.source === 'process' && !selected.processAmbiguous && selected.processInfo) {
          try {
            file = readMuseExecModelForProcess(selected.processInfo)?.sessionFile || null;
          } catch (_) {
            file = null;
          }
        }
        if (!file) {
          file = readMuseSettingsModel()?.filePath || null;
        }
      } else if (selected.family === 'codex') {
        // Codex Desktop reads its composer pick from the global-state file;
        // every CLI/hook Codex tool reads config.toml (the CLI default).
        file = selected.providerId === 'codexApp'
          ? readCodexDesktopModel()?.filePath || null
          : readCodexConfiguredModel()?.filePath || null;
      } else if (selected.family === 'grok') {
        if (selected.sessionId) {
          file = readGrokSessionSummaryModel(selected.sessionId, selected.cwd)?.filePath || null;
        }
        if (!file) {
          file = readGrokDefaultConfigModel()?.filePath || null;
        }
      } else if (selected.family === 'antigravity') {
        const stateFile = getAntigravityStateFile();
        file = (fs.existsSync(stateFile) ? stateFile : null)
          || findActiveAntigravityTranscriptFile()
          || readActiveAntigravityModel()?.filePath
          || null;
      }
    }

    if (file !== getWatchedModelFile()) {
      if (file) {
        watchSelectedModelFile(file, () => requestFastUpdate('model-file'));
        debugLog(`Watching selected ${selected?.family || 'unknown'} model file ${file}.`);
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

function getVerifiedDesktopModelForDisplay(): VerifiedClaudeDesktopModel | null {
  // Retention policy: a verified UI model stays displayable while its PID is
  // still a live Claude Desktop process and the last Desktop observation is
  // under CLAUDE_DESKTOP_MODEL_RETENTION_MS old. Fail closed otherwise
  // (caller clears stale entries).
  const cached = getVerifiedClaudeDesktopModel();
  if (!cached) {
    return null;
  }
  if (!isVerifiedClaudeDesktopModelFresh(cached)) {
    return null;
  }
  if (!claudeDesktopProviderMatchesPid(cached.pid)) {
    return null;
  }
  return cached;
}

function stopClaudeDesktopModelTracker(): void {
  if (claudeDesktopWatcherRestartTimer) {
    clearTimeout(claudeDesktopWatcherRestartTimer);
    claudeDesktopWatcherRestartTimer = null;
  }
  if (claudeDesktopWatcherStarted) {
    claudeDesktopBackoff.noteStop();
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
  if (claudeDesktopWatcherStarted && claudeDesktopExpectedPid === expectedPid) {
    // Started but unhealthy without an exit callback yet: count it as a
    // failed run and wait for the backoff instead of respawning at once.
    try {
      stopClaudeDesktopModelWatcher();
    } catch (_) {
      // Best effort.
    }
    claudeDesktopWatcherStarted = false;
    scheduleClaudeDesktopRestart(expectedPid);
    return;
  }
  if (claudeDesktopBackoff.isGivenUp(expectedPid)) {
    // Helper kept crashing for this Desktop PID: app-only until it changes.
    claudeDesktopExpectedPid = expectedPid;
    return;
  }
  if (!claudeDesktopBackoff.canStart(expectedPid)) {
    // Inside the backoff window; the pending restart timer retries.
    claudeDesktopExpectedPid = expectedPid;
    return;
  }
  claudeDesktopExpectedPid = expectedPid;
  claudeDesktopWatcherStarted = true;
  claudeDesktopBackoff.noteStart(expectedPid);
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
        const currentVerified = getVerifiedClaudeDesktopModel();
        if (currentVerified && currentVerified.pid === expectedPid && claudeDesktopProviderMatchesPid(expectedPid)) {
          debugLog('Claude Desktop model button temporarily unavailable (e.g. Settings view); retaining verified model for live PID.');
          return;
        }
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
        scheduleClaudeDesktopRestart(claudeDesktopExpectedPid);
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
    scheduleClaudeDesktopRestart(expectedPid);
  }
}

function scheduleClaudeDesktopRestart(expectedPid: number): void {
  const delay = claudeDesktopBackoff.noteExit();
  if (claudeDesktopWatcherRestartTimer) {
    clearTimeout(claudeDesktopWatcherRestartTimer);
    claudeDesktopWatcherRestartTimer = null;
  }
  if (delay === null) {
    log(`Claude Desktop model helper failed ${CLAUDE_DESKTOP_HELPER_GIVE_UP_AFTER} times for PID ${expectedPid}; Desktop stays app-only until its PID changes.`);
    return;
  }
  debugLog(`Claude Desktop model helper restart in ${delay}ms (failure ${claudeDesktopBackoff.failures}).`);
  claudeDesktopWatcherRestartTimer = setTimeout(() => {
    claudeDesktopWatcherRestartTimer = null;
    if (!shuttingDown && claudeDesktopExpectedPid === expectedPid) {
      claudeDesktopWatcherStarted = false;
      ensureClaudeDesktopModelTracker(expectedPid);
      requestFastUpdate('desktop-watcher-restart');
    }
  }, delay);
  (claudeDesktopWatcherRestartTimer as unknown as { unref?: () => void }).unref?.();
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
  noteAiActivity(stateTools.length > 0 || processTools.length > 0);
  const merged = mergeActiveTools(stateTools, processTools);
  const displayable = merged.filter((tool) => clientIdForTool(tool));
  const aliveFamilies = new Set(displayable.map((tool) => toolFamilyForTool(tool)));

  // Foreground attribution runs whenever at least one displayable tool is
  // alive (Desktop binding, Muse instance and last-focused retention need it
  // even for a single tool); with no AI tool it costs nothing. Unknown/null/
  // browser/game foreground keeps the remembered family via last-focused
  // retention. An uncached foreground PID never blocks this pass on CIM: the
  // targeted refresh runs in the background (once per non-host PID) and
  // queues a new pass only when it found a terminal host or AI tool.
  // Hook-only mode (PROCESS_DETECTION=off) has no PID attribution: skip the
  // watcher/oneshot census entirely so hook tests stay deterministic and never
  // inherit the real user foreground; newest-hook wins when no AI focus exists.
  let competingForegroundPid: number | null | undefined = undefined;
  let currentForegroundFamily: string | null = null;
  if (PROCESS_DETECTION_ENABLED && displayable.length >= 1) {
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

    competingForegroundPid = typeof foregroundPid === 'number' || foregroundPid === null ? foregroundPid : undefined;
    if (typeof foregroundPid === 'number' && foregroundPid > 0) {
      if (!getCachedProcessByPid(foregroundPid)) {
        const refreshPid = foregroundPid;
        void refreshProcessForPid(refreshPid)
          .then((found) => {
            if (!shuttingDown && found.some((proc) => isHostOrAiProcess(proc))) {
              requestFastUpdate('foreground-refresh');
            }
          })
          .catch((error: unknown) => {
            debugLog(`Foreground refresh failed for ${refreshPid}: ${error instanceof Error ? error.message : String(error)}`);
          });
      }

      const foregroundFamilies = familiesForForegroundProcess(
        foregroundPid,
        getCachedProcessList(),
        toolProviders
      );
      if (foregroundFamilies.length === 1) {
        currentForegroundFamily = foregroundFamilies[0];
      } else if (foregroundFamilies.length > 1) {
        // One host (WindowsTerminal tabs) runs several tools: restrict to
        // those families and pick the most recent hook activity among them.
        currentForegroundFamily = pickAmbiguousForegroundFamily(
          foregroundFamilies,
          displayable,
          (tool) => toolFamilyForTool(tool)
        );
        debugLog(`Foreground host is shared by ${foregroundFamilies.join(', ')}; picked ${currentForegroundFamily || 'none'}.`);
      }
    }
  }

  const effectivePreferred = rememberLastFocusedFamily(currentForegroundFamily, aliveFamilies);

  // Native Muse instance selection (pre-enrich): when several Muse hook
  // sessions compete, only the foreground-associated or retained instance may
  // show its model; otherwise the family stays app-only. Reuses the competing
  // pass foreground PID when available, else the watcher/oneshot fallback
  // with a targeted cache refresh — never a full census.
  let museResolvedTools = merged;
  if (merged.some((tool) => toolFamilyForTool(tool) === 'muse')) {
    const museSessions = readLiveMuseHookSessions();
    const museForegroundPid = competingForegroundPid;
    let foregroundMusePid: number | null = null;
    if (PROCESS_DETECTION_ENABLED && typeof museForegroundPid === 'number' && museForegroundPid > 0) {
      foregroundMusePid = musePidForForegroundProcess(museForegroundPid, getCachedProcessList());
    }
    const museProcesses = getCachedProcessList();
    const museResolution = resolveMuseDisplaySession({
      sessions: museSessions,
      isBindingLive: (binding) => isMuseHookBindingLive(binding, museProcesses),
      foregroundMusePid,
      rememberedSessionId: getRememberedMuseDisplaySession()
    });
    rememberMuseDisplaySession(
      museResolution.kind === 'session' && museResolution.via === 'foreground'
        ? museResolution.session.session_id
        : null,
      museResolution.liveSessionIds
    );
    museResolvedTools = applyMuseDisplayResolution(merged, museResolution);
  } else {
    rememberMuseDisplaySession(null, []);
  }

  // A newer event arrived while this pass was working: abort before any RPC
  // write so stale A is never republished after B. The queued pass reruns
  // with the latest focus/state.
  if (fastQueued && !shuttingDown && consecutiveFastAborts < MAX_CONSECUTIVE_FAST_ABORTS) {
    consecutiveFastAborts += 1;
    debugLog(`Fast pass ${generation} aborted before enrich (newer event queued).`);
    return;
  }

  // Narrow Claude Desktop binding: reuse the already-resolved foreground PID
  // and family from above — never a second persistent helper and never a
  // redundant per-tick census.
  let desktopOverride: ClaudeDesktopDisplayOverride = null;
  const claudeDisplayable = displayable.some((tool) => toolFamilyForTool(tool) === 'claude');
  if (PROCESS_DETECTION_ENABLED && claudeDisplayable) {
    const desktopFgPid = competingForegroundPid;
    const desktopFgFamily = currentForegroundFamily;
    const desktopFgIsDesktop = typeof desktopFgPid === 'number' && desktopFgPid > 0 && claudeDesktopProviderMatchesPid(desktopFgPid);
    if (desktopFgIsDesktop && typeof desktopFgPid === 'number') {
      touchVerifiedClaudeDesktopModel(desktopFgPid);
      ensureClaudeDesktopModelTracker(desktopFgPid);
      const verified = getVerifiedDesktopModelForDisplay();
      if (verified) {
        desktopOverride = { kind: 'model', model: verified.model };
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
        // the last verified Desktop model while its PID stays alive, its last
        // observation is under 10 minutes old, and it is package-bound. The
        // retained label applies only to the Desktop surface: a Claude Code
        // hook with newer activity keeps its own model. Other-AI foreground
        // takes the no-override path below (the Desktop cache stays parked).
        const retained = getVerifiedDesktopModelForDisplay();
        if (retained) {
          desktopOverride = { kind: 'retained', model: retained.model, observedAt: retained.observedAt };
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

  const activeTools = await enrichToolsForPresence(museResolvedTools);

  if (fastQueued && !shuttingDown && consecutiveFastAborts < MAX_CONSECUTIVE_FAST_ABORTS) {
    consecutiveFastAborts += 1;
    debugLog(`Fast pass ${generation} aborted before publish (newer event queued).`);
    return;
  }
  if (fastQueued) {
    debugLog(`Fast pass ${generation} publishing despite a queued event (${consecutiveFastAborts} consecutive aborts).`);
  }
  consecutiveFastAborts = 0;

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

  // Exponential backoff (1s, 2s, 4s ... 60s cap), reset after a healthy run;
  // the oneshot fallback covers the gap.
  // (No give-up limit for the foreground sampler: noteExit never returns null.)
  const delay = foregroundWatcherBackoff.noteExit() ?? HELPER_RESTART_CAP_MS;
  debugLog(`Foreground watcher restart in ${delay}ms (failure ${foregroundWatcherBackoff.failures}).`);
  watcherRestartTimer = setTimeout(() => {
    watcherRestartTimer = null;
    if (shuttingDown) {
      return;
    }

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
    foregroundWatcherBackoff.noteStart(null);
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
  if (pollingStarted) {
    return;
  }

  pollingStarted = true;
  startStateWatcher();
  startForegroundWatcherIfNeeded();
  // Fast init renders hook tools immediately; the slow census then populates
  // the process cache, triggers a second fast pass with full data, and
  // schedules itself (active or idle interval).
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
    clearTimeout(pollTimer);
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
    // destroy() is async and rejects on a null socket; the wrapper swallows
    // that so shutdown never logs an unhandled rejection.
    destroyRpcClient(state.client);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  logError('Unhandled promise rejection', error);
});
process.on('uncaughtException', (error) => {
  // State is unknown after an uncaught exception: log, free the lock so the
  // next start is not refused, and exit non-zero.
  // Other CLI commands (hooks) keep the previous log-only behavior.
  logError('Uncaught exception', error);
  if (!daemonRunning) {
    return;
  }
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  releaseDaemonLock();
  process.exit(1);
});

let daemonRunning = false;

export function startDaemon(): void {
  validateEnvironment();
  if (!acquireDaemonLock()) {
    log('Another daemon instance is already running. Exiting.');
    process.exit(0);
  }
  daemonRunning = true;
  log(`Starting ${APP_TITLE} daemon.`);
  log(`Presence detail level: ${DETAIL_LEVEL}.`);
  startPolling();
}
