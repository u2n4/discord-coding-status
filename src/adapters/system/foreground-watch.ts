'use strict';

import { spawn, type ChildProcess } from 'node:child_process';

// Persistent Windows foreground sampler: ONE hidden PowerShell child that calls
// GetForegroundWindow/GetWindowThreadProcessId every ~120ms and emits PID-only
// lines on change. No titles, text, or window content ever leave the helper.
//
// Verified Win32 signatures (Manager, Microsoft docs):
// - GetForegroundWindow returns HWND/IntPtr/null:
//   https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow
// - GetWindowThreadProcessId(HWND, out DWORD pid) returns DWORD threadId,
//   zero on failure:
//   https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid
//
// Lifecycle: the daemon kills the child on normal exit (stdin close + SIGTERM
// fallback). The child self-exits when the parent PID is gone (polled ~1s) or
// when its stdin pipe reaches EOF (non-blocking BeginRead probe each tick), so
// a crashed daemon cannot orphan it. No new scheduled task is created.

export const FOREGROUND_WATCH_SAMPLE_MS_DEFAULT = 120;
export const FOREGROUND_WATCH_SAMPLE_MS_MIN = 50;
export const FOREGROUND_WATCH_SAMPLE_MS_MAX = 1000;
const PARENT_CHECK_EVERY_TICKS = 8;

export function resolveForegroundSampleMs(): number {
  const text = (process.env.DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS ?? '').trim();
  if (!text) {
    return FOREGROUND_WATCH_SAMPLE_MS_DEFAULT;
  }

  const raw = Number(text);
  if (!Number.isFinite(raw)) {
    return FOREGROUND_WATCH_SAMPLE_MS_DEFAULT;
  }

  const floored = Math.floor(raw);
  if (!Number.isFinite(floored) || floored <= 0) {
    return FOREGROUND_WATCH_SAMPLE_MS_DEFAULT;
  }

  return Math.min(
    FOREGROUND_WATCH_SAMPLE_MS_MAX,
    Math.max(FOREGROUND_WATCH_SAMPLE_MS_MIN, floored)
  );
}

export function isForegroundWatchEnabled(): boolean {
  const raw = (process.env.DISCORD_CODING_STATUS_FOREGROUND_WATCH || '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') {
    return false;
  }

  return true;
}

// Builds the sampler script. Exported so tests can assert Add-Type-once,
// PID-only output, parent-death/stdin-EOF cleanup, and the absence of any
// title/text capture without spawning PowerShell.
export function buildForegroundSamplerScript(parentPid: number, sampleMs: number): string {
  const flooredParent = Math.floor(parentPid);
  if (!Number.isFinite(parentPid) || !Number.isFinite(flooredParent) || flooredParent <= 0) {
    throw new Error(`Invalid parent PID for foreground sampler: ${String(parentPid)}`);
  }
  const safeParent = flooredParent;
  const flooredSample = Math.floor(sampleMs);
  const safeSample = !Number.isFinite(flooredSample) || flooredSample <= 0
    ? FOREGROUND_WATCH_SAMPLE_MS_DEFAULT
    : Math.min(
      FOREGROUND_WATCH_SAMPLE_MS_MAX,
      Math.max(FOREGROUND_WATCH_SAMPLE_MS_MIN, flooredSample)
    );

  // NOTE: never name a variable `$pid` (PowerShell automatic variable); every
  // sampler variable uses the `$watch*` prefix. Only one Write-Output exists
  // and it emits the numeric foreground PID (0 = unknown). Failures go to
  // stderr (Write-Error) with a bounded exit so the daemon falls back to the
  // oneshot path instead of staying healthy emitting 0 forever.
  return [
    "$ErrorActionPreference='Stop'",
    'try { Add-Type -Namespace Win32 -Name ForegroundSampler -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);\' | Out-Null } catch { Write-Error ("foreground sampler type-load failed: " + $_.Exception.Message); exit 2 }',
    `$watchParent=${safeParent}`,
    'if ($watchParent -le 0) { Write-Error ("foreground sampler invalid parent"); exit 2 }',
    `$watchSample=${safeSample}`,
    '$watchLast=-1',
    '$watchTicks=0',
    '$watchFail=0',
    '$watchStdin=$null',
    '$watchAsync=$null',
    '$watchBuf=$null',
    'try { $watchStdin=[Console]::OpenStandardInput(); $watchBuf=New-Object byte[] 16; $watchAsync=$watchStdin.BeginRead($watchBuf,0,$watchBuf.Length,$null,$null) } catch { $watchStdin=$null; $watchAsync=$null }',
    'while ($true) {',
    ' if ($watchAsync -ne $null) { try { if ($watchAsync.AsyncWaitHandle.WaitOne(0)) { try { $null=$watchStdin.EndRead($watchAsync) } catch {} exit 0 } } catch { exit 0 } }',
    ` $watchTicks++; if (($watchTicks % ${PARENT_CHECK_EVERY_TICKS}) -eq 0) { try { $watchParentProc=Get-Process -Id $watchParent -ErrorAction Stop; if ($null -eq $watchParentProc) { exit 0 } } catch { exit 0 } }`,
    ' $watchFg=0',
    ' try { $watchHwnd=[Win32.ForegroundSampler]::GetForegroundWindow(); if ($watchHwnd -ne $null -and $watchHwnd -ne [IntPtr]::Zero) { $watchOwner=[uint32]0; $watchTid=[Win32.ForegroundSampler]::GetWindowThreadProcessId($watchHwnd,[ref]$watchOwner); if ($watchTid -ne 0 -and $watchOwner -ne 0) { $watchFg=[int]$watchOwner; $watchFail=0 } else { $watchFail++; $watchFg=0 } } else { $watchFail=0; $watchFg=0 } } catch { $watchFail++; $watchFg=0; if ($watchFail -ge 20) { Write-Error ("foreground sampler native API failed: " + $_.Exception.Message); exit 3 } }',
    ' if ($watchFail -ge 20) { Write-Error ("foreground sampler native API failed consecutively"); exit 3 }',
    ' if ($watchFg -ne $watchLast) { $watchLast=$watchFg; Write-Output $watchFg }',
    ' Start-Sleep -Milliseconds $watchSample',
    '}'
  ].join('; ');
}

export interface ForegroundWatcherStats {
  available: boolean;
  pid: number | null;
  startedAt: number | null;
  sampleMs: number;
  changes: number;
  lastPid: number | null;
  restarts: number;
  lastError: string | null;
  uptimeMs: number | null;
  estimatedSamples: number | null;
}

export interface ForegroundWatcherHandle {
  child: ChildProcess;
  pid: number;
  startedAt: number;
  sampleMs: number;
}

let activeChild: ChildProcess | null = null;
let activeHandle: ForegroundWatcherHandle | null = null;
let activeOnPid: ((pid: number | null) => void) | null = null;
let activeOnExit: (() => void) | null = null;
let stdoutBuffer = '';
let stderrBuffer = '';
let stderrCaptured = false;
let changes = 0;
let lastPid: number | null = null;
let restarts = 0;
let lastError: string | null = null;
let startCount = 0;

function resetActiveState(): void {
  activeChild = null;
  activeHandle = null;
  activeOnPid = null;
  activeOnExit = null;
  stdoutBuffer = '';
  stderrBuffer = '';
}

function handleStderrChunk(chunk: string): void {
  if (stderrCaptured) {
    return;
  }
  stderrBuffer += chunk;
  if (stderrBuffer.length > 2048) {
    stderrBuffer = stderrBuffer.slice(-2048);
  }
  const line = stderrBuffer.split('\n').map((entry) => entry.trim()).find(Boolean);
  if (line) {
    lastError = line.slice(0, 512);
    stderrCaptured = true;
  }
}

function handleStdoutChunk(chunk: string): void {
  stdoutBuffer += chunk;
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop() || '';

  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      continue;
    }

    // PID-only protocol: a bare integer per change, 0 for unknown.
    const parsed = Number(text);
    const pid = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    if (pid === lastPid && changes > 0) {
      continue;
    }

    changes += 1;
    lastPid = pid;

    try {
      activeOnPid?.(pid);
    } catch (_) {
      // Listener errors must never kill the sampler loop.
    }
  }
}

export interface StartForegroundWatcherOptions {
  parentPid?: number;
  sampleMs?: number;
}

export function startForegroundWatcher(
  onPid: (pid: number | null) => void,
  onExit?: () => void,
  options: StartForegroundWatcherOptions = {}
): ForegroundWatcherHandle | null {
  const parentPid = options.parentPid ?? process.pid;
  if (!Number.isFinite(parentPid) || Math.floor(parentPid) <= 0) {
    lastError = `foreground sampler invalid parent PID: ${String(parentPid)}`;
    return null;
  }

  if (process.platform !== 'win32') {
    return null;
  }

  // ONE helper: never spawn a second sampler while the current child is alive.
  if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
    return activeHandle;
  }

  const sampleMs = options.sampleMs ?? resolveForegroundSampleMs();
  let script: string;
  try {
    script = buildForegroundSamplerScript(parentPid, sampleMs);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return null;
  }

  let child: ChildProcess;
  try {
    child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false
    });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return null;
  }

  if (!child.pid) {
    lastError = 'foreground sampler spawned without a PID';
    try {
      child.kill();
    } catch (_) {
      // Best effort cleanup for a failed spawn.
    }
    return null;
  }

  // Verify the child is actually live, not merely spawned.
  if (child.exitCode !== null || child.signalCode !== null) {
    lastError = 'foreground sampler exited before becoming ready';
    return null;
  }
  try {
    process.kill(child.pid, 0);
  } catch (_) {
    lastError = 'foreground sampler PID is not alive after spawn';
    return null;
  }

  startCount += 1;
  if (startCount > 1) {
    restarts += 1;
  }
  lastError = null;

  activeChild = child;
  activeOnPid = onPid;
  activeOnExit = onExit || null;
  stdoutBuffer = '';
  stderrBuffer = '';
  stderrCaptured = false;
  activeHandle = {
    child,
    pid: child.pid,
    startedAt: Date.now(),
    sampleMs
  };

  try {
    child.stdin?.on('error', () => {});
  } catch (_) {
    // stdin error listeners are best effort.
  }

  try {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => {
      handleStdoutChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
  } catch (_) {
    // stdout listeners are best effort.
  }

  try {
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string | Buffer) => {
      handleStderrChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
  } catch (_) {
    // stderr listeners are best effort.
  }

  const notifyExit = (error?: unknown, exitCode?: number | null): void => {
    if (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } else if (typeof exitCode === 'number' && exitCode !== 0 && !stderrCaptured) {
      lastError = `foreground sampler exited with code ${exitCode}`;
    }

    const callback = activeOnExit;
    // Clear active state before invoking the callback so a restart from the
    // callback cannot observe a half-dead singleton.
    const wasActive = activeChild === child;
    if (wasActive) {
      resetActiveState();
    }

    if (wasActive && callback) {
      try {
        callback();
      } catch (_) {
        // Exit listeners must never throw.
      }
    }
  };

  child.on('error', (error: unknown) => notifyExit(error));
  child.on('exit', (code: number | null) => notifyExit(undefined, code));

  return activeHandle;
}

export function stopForegroundWatcher(): void {
  const child = activeChild;
  const callbackSuppressed = activeOnExit;
  // Suppress the exit callback: a deliberate stop is not a crash and must not
  // schedule a restart.
  activeOnExit = null;

  if (!child) {
    resetActiveState();
    return;
  }

  resetActiveState();
  void callbackSuppressed;

  // Normal-exit path: closing stdin lets the sampler observe EOF and exit on
  // its own within a tick; SIGTERM/SIGKILL are fallbacks if it lingers.
  try {
    child.stdin?.end();
  } catch (_) {
    // Best effort stdin close.
  }

  const terminate = setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    } catch (_) {
      // Best effort termination.
    }
  }, 400);
  (terminate as unknown as { unref?: () => void }).unref?.();

  const fallback = setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    } catch (_) {
      // Best effort termination.
    }
  }, 900);
  (fallback as unknown as { unref?: () => void }).unref?.();
}

export function isForegroundWatcherHealthy(): boolean {
  if (!activeChild || !activeHandle) {
    return false;
  }
  if (activeChild.exitCode !== null || activeChild.signalCode !== null) {
    return false;
  }
  try {
    if (typeof activeHandle.pid === 'number' && activeHandle.pid > 0) {
      process.kill(activeHandle.pid, 0);
    }
  } catch (_) {
    return false;
  }
  return true;
}

export function getForegroundWatcherStats(): ForegroundWatcherStats {
  const sampleMs = activeHandle?.sampleMs ?? resolveForegroundSampleMs();
  const startedAt = activeHandle?.startedAt ?? null;
  const uptimeMs = startedAt === null ? null : Math.max(0, Date.now() - startedAt);

  return {
    available: isForegroundWatcherHealthy(),
    pid: activeHandle?.pid ?? null,
    startedAt,
    sampleMs,
    changes,
    lastPid,
    restarts,
    lastError,
    uptimeMs,
    estimatedSamples: uptimeMs === null ? null : Math.floor(uptimeMs / sampleMs)
  };
}

export function resetForegroundWatcherForTests(): void {
  try {
    stopForegroundWatcher();
  } catch (_) {
    resetActiveState();
  }

  changes = 0;
  lastPid = null;
  restarts = 0;
  lastError = null;
  startCount = 0;
  stderrBuffer = '';
  stderrCaptured = false;
}
