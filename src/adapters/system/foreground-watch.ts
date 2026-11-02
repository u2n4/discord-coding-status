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

  // The sampling loop runs as compiled C# inside the one PowerShell helper:
  // SetWinEventHook(EVENT_SYSTEM_FOREGROUND) reports a focus change the moment
  // it happens (no polling), and a 1 s timer re-reads the foreground window to
  // catch anything the hook missed and checks that the parent daemon is still
  // alive. stdin EOF (daemon gone or stopping) exits immediately. If the hook
  // cannot be installed the helper falls back to polling every $watchSample ms.
  // stdout stays PID-only (0 = unknown); failures go to stderr with exit 2/3 so
  // the daemon falls back to the oneshot path. Never name a variable `$pid`
  // (PowerShell automatic variable): script variables use the `$watch*` prefix.
  const csharp = [
    'using System; using System.Diagnostics; using System.Runtime.InteropServices; using System.Threading;',
    'namespace Win32 { public static class ForegroundSampler {',
    'public delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);',
    '[StructLayout(LayoutKind.Sequential)] public struct Msg { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }',
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
    '[DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc callback, uint processId, uint threadId, uint flags);',
    '[DllImport("user32.dll")] static extern int GetMessage(out Msg msg, IntPtr hwnd, uint filterMin, uint filterMax);',
    'static WinEventProc hookCallback; static Timer checkTimer; static int lastForeground = -1; static int failures = 0; static readonly object gate = new object();',
    'static void Emit() { int foreground = 0; try { IntPtr hwnd = GetForegroundWindow(); if (hwnd != IntPtr.Zero) { uint owner = 0; uint thread = GetWindowThreadProcessId(hwnd, out owner); if (thread != 0 && owner != 0) { foreground = (int)owner; } } failures = 0; } catch (Exception error) { failures++; if (failures >= 20) { Console.Error.WriteLine("foreground sampler native API failed: " + error.Message); Environment.Exit(3); } }',
    ' lock (gate) { if (foreground != lastForeground) { lastForeground = foreground; Console.Out.WriteLine(foreground); Console.Out.Flush(); } } }',
    'public static int Run(int parent, int sampleMs) {',
    ' Thread stdinWatch = new Thread(delegate() { try { System.IO.Stream input = Console.OpenStandardInput(); byte[] buffer = new byte[16]; while (input.Read(buffer, 0, buffer.Length) > 0) { } } catch { } Environment.Exit(0); });',
    ' stdinWatch.IsBackground = true; stdinWatch.Start();',
    ' checkTimer = new Timer(delegate(object state) { try { Process.GetProcessById(parent).Dispose(); } catch { Environment.Exit(0); } Emit(); }, null, 1000, 1000);',
    ' hookCallback = new WinEventProc(delegate(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) { Emit(); });',
    ' IntPtr installed = SetWinEventHook(3, 3, IntPtr.Zero, hookCallback, 0, 0, 0);',
    ' Emit();',
    ' if (installed == IntPtr.Zero) { while (true) { Thread.Sleep(sampleMs); Emit(); } }',
    ' Msg message; while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }',
    ' return 0; } } }'
  ].join(' ');

  return [
    "$ErrorActionPreference='Stop'",
    `try { Add-Type -TypeDefinition '${csharp}' | Out-Null } catch { Write-Error ("foreground sampler type-load failed: " + $_.Exception.Message); exit 2 }`,
    `$watchParent=${safeParent}`,
    'if ($watchParent -le 0) { Write-Error ("foreground sampler invalid parent"); exit 2 }',
    `$watchSample=${safeSample}`,
    'exit [Win32.ForegroundSampler]::Run($watchParent, $watchSample)'
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
