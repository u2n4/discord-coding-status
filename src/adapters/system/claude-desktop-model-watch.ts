'use strict';

import { spawn, type ChildProcess } from 'node:child_process';
import { CLAUDE_DESKTOP_MODEL_LABEL_MAX_LENGTH } from '../../core/detection/claude-desktop-model';
import type { ActiveTool } from '../../core/tools/types';

// Persistent Claude Desktop selected-model sampler (Windows only).
//
// ONE hidden PowerShell child queries ONLY the positively bound CURRENT
// Claude foreground window (expectedPid from the daemon, verified each tick
// via GetForegroundWindow + GetWindowThreadProcessId) for the model selector
// button (Button-only FindAll, exact "Model:" prefix via StartsWith, FIRST
// text child only). No conversation, project, or general UI text is ever
// read, copied, or logged; non-matching button Names are discarded in-helper.
// Output protocol on stdout, change-only (no per-tick spam):
//   MODEL|<label>  positively bound model child label (e.g. Opus 5.5)
//   UNBOUND        foreground is not the expected Desktop PID (focus moved)
//   UNAVAILABLE    foreground matches but the selector is missing/ambiguous
// Failures go to stderr (Write-Error) with bounded exits (2 startup, 3
// consecutive native/UIA), so the daemon falls back to app-only instead of
// showing a stale or guessed model.
//
// Lifecycle mirrors the foreground sampler: the daemon closes stdin on normal
// stop (helper observes EOF and exits within a tick); the helper self-exits
// when the parent PID is gone (polled ~1s) so a crashed daemon cannot orphan
// it. No PowerShell process is spawned per tick: the helper persists while
// its Desktop window is foreground and restarts only on window/PID change.
// The 120ms foreground sampler stays unblocked (separate process); model
// polling runs at 500ms with a cached button selector (fast path re-reads
// the cached element; slow Button-only FindAll runs only on cache miss).
//
// Managed UIA notes (see core/detection/claude-desktop-model.ts for URLs):
// managed PropertyConditionFlags has no MatchSubstring, so the "Model:"
// prefix is matched client-side after a Button-only query. Native
// MatchSubstring (0x2) would need a native COM interface and is not used.

export const CLAUDE_DESKTOP_MODEL_SAMPLE_MS_DEFAULT = 500;
export const CLAUDE_DESKTOP_MODEL_SAMPLE_MS_MIN = 250;
export const CLAUDE_DESKTOP_MODEL_SAMPLE_MS_MAX = 2000;
const PARENT_CHECK_EVERY_TICKS = 2;
const MAX_CONSECUTIVE_FAILURES = 20;
const LF = String.fromCharCode(10);

function clampSampleMs(sampleMs: number): number {
  const floored = Math.floor(sampleMs);
  if (!Number.isFinite(floored) || floored <= 0) {
    return CLAUDE_DESKTOP_MODEL_SAMPLE_MS_DEFAULT;
  }

  return Math.min(
    CLAUDE_DESKTOP_MODEL_SAMPLE_MS_MAX,
    Math.max(CLAUDE_DESKTOP_MODEL_SAMPLE_MS_MIN, floored)
  );
}

// Builds the sampler script. Exported so tests can assert Button-only scope,
// exact-prefix filtering, first-child-only reads, parent-death/stdin-EOF
// cleanup, and the absence of conversation scraping without spawning
// PowerShell. TS template literals carry the PowerShell: `$watch*` names are
// PowerShell variables (preserved); `${...}` spots are TS-interpolated
// numbers only. The script itself contains no hardcoded PID/HWND/version.
export function buildClaudeDesktopModelSamplerScript(
  expectedPid: number,
  parentPid: number,
  sampleMs: number = CLAUDE_DESKTOP_MODEL_SAMPLE_MS_DEFAULT
): string {
  const flooredExpected = Math.floor(expectedPid);
  if (!Number.isFinite(expectedPid) || !Number.isFinite(flooredExpected) || flooredExpected <= 0) {
    throw new Error(`Invalid expected PID for Claude Desktop model sampler: ${String(expectedPid)}`);
  }

  const flooredParent = Math.floor(parentPid);
  if (!Number.isFinite(parentPid) || !Number.isFinite(flooredParent) || flooredParent <= 0) {
    throw new Error(`Invalid parent PID for Claude Desktop model sampler: ${String(parentPid)}`);
  }

  const safeExpected = flooredExpected;
  const safeParent = flooredParent;
  const safeSample = clampSampleMs(sampleMs);

  // NOTE: never name a variable `$pid` (PowerShell automatic variable); every
  // sampler variable uses the `$watch*` prefix. Exactly one Write-Output
  // exists and it emits only the validated state line (MODEL|<label> /
  // UNBOUND / UNAVAILABLE). No button Names, labels, or UI dumps are logged.
  return [
    `$ErrorActionPreference='Stop'`,
    `try { Add-Type -AssemblyName UIAutomationClient } catch { Write-Error ("claude desktop model uia load failed: " + $_.Exception.Message); exit 2 }`,
    `try { Add-Type -Namespace Win32 -Name ClaudeDesktopModelSampler -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);' | Out-Null } catch { Write-Error ("claude desktop model type-load failed: " + $_.Exception.Message); exit 2 }`,
    `$watchParent=${safeParent}`,
    `if ($watchParent -le 0) { Write-Error ("claude desktop model invalid parent"); exit 2 }`,
    `$watchExpected=${safeExpected}`,
    `if ($watchExpected -le 0) { Write-Error ("claude desktop model invalid expected pid"); exit 2 }`,
    `$watchSample=${safeSample}`,
    `$watchLast='__INIT__'`,
    `$watchTicks=0`,
    `$watchFail=0`,
    `$watchButton=$null`,
    `$watchStdin=$null`,
    `$watchAsync=$null`,
    `$watchBuf=$null`,
    `try { $watchStdin=[Console]::OpenStandardInput(); $watchBuf=New-Object byte[] 16; $watchAsync=$watchStdin.BeginRead($watchBuf,0,$watchBuf.Length,$null,$null) } catch { $watchStdin=$null; $watchAsync=$null }`,
    `while ($true) {`,
    ` if ($watchAsync -ne $null) { try { if ($watchAsync.AsyncWaitHandle.WaitOne(0)) { try { $null=$watchStdin.EndRead($watchAsync) } catch {} exit 0 } } catch { exit 0 } }`,
    ` $watchTicks++; if (($watchTicks % ${PARENT_CHECK_EVERY_TICKS}) -eq 0) { try { $watchParentProc=Get-Process -Id $watchParent -ErrorAction Stop; if ($null -eq $watchParentProc) { exit 0 } } catch { exit 0 } }`,
    ` $watchFg=0; $watchHwnd=[IntPtr]::Zero`,
    ` try { $watchHwnd=[Win32.ClaudeDesktopModelSampler]::GetForegroundWindow(); if ($watchHwnd -ne $null -and $watchHwnd -ne [IntPtr]::Zero) { $watchOwner=[uint32]0; $watchTid=[Win32.ClaudeDesktopModelSampler]::GetWindowThreadProcessId($watchHwnd,[ref]$watchOwner); if ($watchTid -ne 0 -and $watchOwner -ne 0) { $watchFg=[int]$watchOwner; $watchFail=0 } else { $watchFail++; $watchFg=0 } } else { $watchFail=0; $watchFg=0; $watchHwnd=[IntPtr]::Zero } } catch { $watchFail++; $watchFg=0; $watchHwnd=[IntPtr]::Zero; if ($watchFail -ge ${MAX_CONSECUTIVE_FAILURES}) { Write-Error ("claude desktop model native api failed: " + $_.Exception.Message); exit 3 } }`,
    ` if ($watchFail -ge ${MAX_CONSECUTIVE_FAILURES}) { Write-Error ("claude desktop model native api failed consecutively"); exit 3 }`,
    ` $watchState='UNAVAILABLE'`,
    ` if ($watchFg -ne $watchExpected) { $watchButton=$null; $watchState='UNBOUND' } else {`,
    ` try { $watchRoot=[System.Windows.Automation.AutomationElement]::FromHandle($watchHwnd); if ($watchRoot -ne $null -and $watchRoot.Current.ProcessId -eq $watchExpected) {`,
    ` $watchFound=$null`,
    ` if ($watchButton -ne $null) { try { $watchCachedName=$watchButton.Current.Name; if ($watchCachedName -ne $null -and $watchCachedName.Trim().StartsWith('Model:')) { $watchFound=$watchButton } else { $watchButton=$null } } catch { $watchButton=$null } }`,
    ` if ($watchFound -eq $null) { $watchCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button); $watchButtons=$watchRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $watchCond); $watchMatch=$null; $watchMatchCount=0; foreach ($watchB in $watchButtons) { try { $watchN=$watchB.Current.Name } catch { continue }; if ($watchN -ne $null -and $watchN.Trim().StartsWith('Model:')) { $watchMatchCount++; if ($watchMatchCount -eq 1) { $watchMatch=$watchB } } }; if ($watchMatchCount -eq 1) { $watchFound=$watchMatch; $watchButton=$watchMatch } else { $watchButton=$null } }`,
    ` if ($watchFound -ne $null) { try { $watchChildCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text); $watchChild=$watchFound.FindFirst([System.Windows.Automation.TreeScope]::Children, $watchChildCond); if ($watchChild -ne $null) { $watchLabel=$watchChild.Current.Name; if ($watchLabel -ne $null) { $watchLabel=$watchLabel.Trim(); if ($watchLabel -ne '' -and $watchLabel.Length -le ${CLAUDE_DESKTOP_MODEL_LABEL_MAX_LENGTH}) { $watchState='MODEL|'+$watchLabel } } } } catch { $watchState='UNAVAILABLE' } }`,
    ` }; $watchFail=0 } catch { $watchFail++; if ($watchFail -ge ${MAX_CONSECUTIVE_FAILURES}) { Write-Error ("claude desktop model uia failed: " + $_.Exception.Message); exit 3 } }`,
    ` }`,
    ` if ($watchState -ne $watchLast) { $watchLast=$watchState; Write-Output $watchState }`,
    ` Start-Sleep -Milliseconds $watchSample`,
    `}`
  ].join('; ');
}

export type ClaudeDesktopModelEvent =
  | { kind: 'model'; model: string }
  | { kind: 'unbound' }
  | { kind: 'unavailable' };

export interface ClaudeDesktopModelWatcherStats {
  available: boolean;
  pid: number | null;
  expectedPid: number | null;
  startedAt: number | null;
  sampleMs: number;
  changes: number;
  lastModel: string | null;
  lastState: string | null;
  restarts: number;
  lastError: string | null;
  uptimeMs: number | null;
}

export interface ClaudeDesktopModelWatcherHandle {
  child: ChildProcess;
  pid: number;
  expectedPid: number;
  startedAt: number;
  sampleMs: number;
}

let activeChild: ChildProcess | null = null;
let activeHandle: ClaudeDesktopModelWatcherHandle | null = null;
let activeOnEvent: ((event: ClaudeDesktopModelEvent) => void) | null = null;
let activeOnExit: (() => void) | null = null;
let stdoutBuffer = '';
let stderrBuffer = '';
let stderrCaptured = false;
let changes = 0;
let lastModel: string | null = null;
let lastState: string | null = null;
let restarts = 0;
let lastError: string | null = null;
let startCount = 0;

function resetActiveState(): void {
  activeChild = null;
  activeHandle = null;
  activeOnEvent = null;
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
  const line = stderrBuffer.split(LF).map((entry) => entry.trim()).find(Boolean);
  if (line) {
    lastError = line.slice(0, 512);
    stderrCaptured = true;
  }
}

function emitEvent(event: ClaudeDesktopModelEvent, stateKey: string): void {
  if (stateKey === lastState && changes > 0) {
    return;
  }
  changes += 1;
  lastState = stateKey;
  if (event.kind === 'model') {
    lastModel = event.model;
  }
  try {
    activeOnEvent?.(event);
  } catch (_) {
    // Listener errors must never kill the sampler loop.
  }
}

function handleStdoutChunk(chunk: string): void {
  stdoutBuffer += chunk;
  const lines = stdoutBuffer.split(LF);
  stdoutBuffer = lines.pop() || '';

  for (const rawLine of lines) {
    const text = rawLine.trim();
    if (!text) {
      continue;
    }

    if (text.startsWith('MODEL|')) {
      const label = text.slice('MODEL|'.length).trim();
      if (!label || label.length > CLAUDE_DESKTOP_MODEL_LABEL_MAX_LENGTH) {
        emitEvent({ kind: 'unavailable' }, 'UNAVAILABLE');
        continue;
      }
      emitEvent({ kind: 'model', model: label }, 'MODEL|' + label);
      continue;
    }

    if (text === 'UNBOUND') {
      emitEvent({ kind: 'unbound' }, 'UNBOUND');
      continue;
    }

    if (text === 'UNAVAILABLE') {
      emitEvent({ kind: 'unavailable' }, 'UNAVAILABLE');
      continue;
    }

    // Unknown lines are ignored (fail closed, never crash on helper skew).
  }
}

export interface StartClaudeDesktopModelWatcherOptions {
  expectedPid: number;
  parentPid?: number;
  sampleMs?: number;
}

export function startClaudeDesktopModelWatcher(
  onEvent: (event: ClaudeDesktopModelEvent) => void,
  onExit?: () => void,
  options?: StartClaudeDesktopModelWatcherOptions
): ClaudeDesktopModelWatcherHandle | null {
  const expectedPid = options?.expectedPid;
  if (!Number.isFinite(expectedPid as number) || Math.floor(expectedPid as number) <= 0) {
    lastError = `claude desktop model watcher invalid expected PID: ${String(expectedPid)}`;
    return null;
  }
  const parentPid = options?.parentPid ?? process.pid;
  if (!Number.isFinite(parentPid) || Math.floor(parentPid) <= 0) {
    lastError = `claude desktop model watcher invalid parent PID: ${String(parentPid)}`;
    return null;
  }

  if (process.platform !== 'win32') {
    return null;
  }

  const safeExpected = Math.floor(expectedPid as number);

  // ONE helper: reuse while healthy for the same PID; restart (stop + spawn)
  // when the bound window changed. The old child self-exits via stdin EOF and
  // parent checks, so a brief overlap on window switch cannot orphan.
  if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
    if (activeHandle && activeHandle.expectedPid === safeExpected) {
      return activeHandle;
    }
    try {
      stopClaudeDesktopModelWatcher();
    } catch (_) {
      resetActiveState();
    }
  }

  const sampleMs = clampSampleMs(options?.sampleMs ?? CLAUDE_DESKTOP_MODEL_SAMPLE_MS_DEFAULT);
  let script: string;
  try {
    script = buildClaudeDesktopModelSamplerScript(safeExpected, parentPid, sampleMs);
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
    lastError = 'claude desktop model sampler spawned without a PID';
    try {
      child.kill();
    } catch (_) {
      // Best effort cleanup for a failed spawn.
    }
    return null;
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    lastError = 'claude desktop model sampler exited before becoming ready';
    return null;
  }
  try {
    process.kill(child.pid, 0);
  } catch (_) {
    lastError = 'claude desktop model sampler PID is not alive after spawn';
    return null;
  }

  startCount += 1;
  if (startCount > 1) {
    restarts += 1;
  }
  lastError = null;

  activeChild = child;
  activeOnEvent = onEvent;
  activeOnExit = onExit || null;
  stdoutBuffer = '';
  stderrBuffer = '';
  stderrCaptured = false;
  activeHandle = {
    child,
    pid: child.pid,
    expectedPid: safeExpected,
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
      lastError = `claude desktop model sampler exited with code ${exitCode}`;
    }

    const callback = activeOnExit;
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

export function stopClaudeDesktopModelWatcher(): void {
  const child = activeChild;
  activeOnExit = null;

  if (!child) {
    resetActiveState();
    return;
  }

  resetActiveState();

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

export function isClaudeDesktopModelWatcherHealthy(): boolean {
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

export function getClaudeDesktopModelWatcherStats(): ClaudeDesktopModelWatcherStats {
  const sampleMs = activeHandle?.sampleMs ?? CLAUDE_DESKTOP_MODEL_SAMPLE_MS_DEFAULT;
  const startedAt = activeHandle?.startedAt ?? null;
  const uptimeMs = startedAt === null ? null : Math.max(0, Date.now() - startedAt);

  return {
    available: isClaudeDesktopModelWatcherHealthy(),
    pid: activeHandle?.pid ?? null,
    expectedPid: activeHandle?.expectedPid ?? null,
    startedAt,
    sampleMs,
    changes,
    lastModel,
    lastState,
    restarts,
    lastError,
    uptimeMs
  };
}

export function resetClaudeDesktopModelWatcherForTests(): void {
  try {
    stopClaudeDesktopModelWatcher();
  } catch (_) {
    resetActiveState();
  }

  changes = 0;
  lastModel = null;
  lastState = null;
  restarts = 0;
  lastError = null;
  startCount = 0;
  stderrBuffer = '';
  stderrCaptured = false;
  clearVerifiedClaudeDesktopModel();
}

export interface VerifiedClaudeDesktopModel {
  pid: number;
  model: string;
  updatedAt: number;
}

let verifiedDesktopModel: VerifiedClaudeDesktopModel | null = null;

export function getVerifiedClaudeDesktopModel(): VerifiedClaudeDesktopModel | null {
  return verifiedDesktopModel ? { ...verifiedDesktopModel } : null;
}

export function setVerifiedClaudeDesktopModel(pid: number, model: string): void {
  if (!Number.isFinite(pid) || Math.floor(pid) <= 0) {
    return;
  }
  if (typeof model !== 'string') {
    return;
  }
  const label = model.trim();
  if (!label || label.length > CLAUDE_DESKTOP_MODEL_LABEL_MAX_LENGTH) {
    return;
  }
  verifiedDesktopModel = { pid: Math.floor(pid), model: label, updatedAt: Date.now() };
}

export function clearVerifiedClaudeDesktopModel(): void {
  verifiedDesktopModel = null;
}

export function resetClaudeDesktopModelCacheForTests(): void {
  verifiedDesktopModel = null;
}

export type ClaudeDesktopDisplayOverride =
  | { kind: 'model'; model: string }
  | { kind: 'app-only' }
  | null;

function truncateDesktopDetails(value: string): string {
  // Mirrors presence-text truncation (128, ellipsis) for already-trimmed
  // single-line UI labels; adapters cannot import top-level presence-text.
  const text = value.trim();
  if (text.length <= 128) {
    return text;
  }
  return text.slice(0, 125) + '...';
}

export function applyClaudeDesktopDisplayOverride(
  tools: readonly ActiveTool[],
  override: ClaudeDesktopDisplayOverride
): ActiveTool[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  if (!override) {
    return [...tools];
  }

  let touched = false;
  const next = tools.map((tool) => {
    if (!tool || tool.family !== 'claude') {
      return tool;
    }
    touched = true;
    if (override.kind === 'app-only') {
      return { ...tool, details: '', state: '' };
    }
    const label = override.model.trim();
    if (!label) {
      return { ...tool, details: '', state: '' };
    }
    return { ...tool, details: truncateDesktopDetails('Model: ' + label), state: '' };
  });

  return touched ? next : [...tools];
}
