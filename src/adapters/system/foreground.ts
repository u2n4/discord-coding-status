'use strict';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessInfo, ToolFamily } from '../../core/tools/types';
import type { ToolProvider } from '../../core/providers/types';
import { isMuseProcess } from '../../core/detection/tool-detection';

const execFileAsync = promisify(execFile);
const FOREGROUND_TIMEOUT_MS = 5_000;
const MAX_DESCENDANT_DEPTH = 4;

/**
 * Returns the PID holding the Windows foreground window, or null when it
 * cannot be determined. Fail-closed: any error means "unknown", never a
 * guessed PID.
 */
export async function getForegroundPid(): Promise<number | null> {
  if (process.platform !== 'win32') {
    return null;
  }

  // Verified signatures: GetForegroundWindow returns HWND/IntPtr (null/Zero when
  // unknown); GetWindowThreadProcessId returns the thread id, zero on failure.
  // https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow
  // https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid
  const command = [
    'Add-Type -Namespace Win32 -Name ForegroundWindow -MemberDefinition \'',
    '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();',
    ' [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);',
    '\' | Out-Null; $window = [Win32.ForegroundWindow]::GetForegroundWindow();',
    ' $owner = [uint32]0; $threadId = 0;',
    ' if ($window -ne $null -and $window -ne [IntPtr]::Zero) { $threadId = [Win32.ForegroundWindow]::GetWindowThreadProcessId($window, [ref]$owner); }',
    ' if ($threadId -eq 0) { $owner = 0 };',
    ' Write-Output $owner'
  ].join('');

  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command
    ], {
      timeout: FOREGROUND_TIMEOUT_MS,
      maxBuffer: 1024
    }) as { stdout: string };

    const pid = Number((stdout || '').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

function childrenByParent(processes: readonly ProcessInfo[]): Map<number, ProcessInfo[]> {
  const children = new Map<number, ProcessInfo[]>();
  for (const process of processes) {
    if (typeof process.ppid !== 'number') {
      continue;
    }

    const siblings = children.get(process.ppid) || [];
    siblings.push(process);
    children.set(process.ppid, siblings);
  }

  return children;
}

/**
 * Collects every tool family that owns the foreground window. Terminal-hosted
 * CLI sessions own no window themselves, so descendants of the foreground PID
 * (terminal -> shell -> agent, a few levels deep) are considered as well.
 * Several families mean one host (e.g. WindowsTerminal.exe tabs) runs more
 * than one tool; the caller decides how to break that tie.
 */
export function familiesForForegroundProcess(
  foregroundPid: number,
  processes: readonly ProcessInfo[],
  providers: readonly ToolProvider[]
): ToolFamily[] {
  const byPid = new Map<number, ProcessInfo>();
  for (const process of processes) {
    byPid.set(process.pid, process);
  }

  const root = byPid.get(foregroundPid);
  if (!root) {
    return [];
  }

  const children = childrenByParent(processes);
  const queue: Array<{ process: ProcessInfo; depth: number }> = [{ process: root, depth: 0 }];
  const families = new Set<ToolFamily>();

  while (queue.length > 0) {
    const { process, depth } = queue.shift() as { process: ProcessInfo; depth: number };

    let matchedAtNode = false;
    for (const provider of providers) {
      if (provider.process && provider.presence && provider.process.matches(process)) {
        families.add(provider.family);
        matchedAtNode = true;
      }
    }

    if (!matchedAtNode && depth < MAX_DESCENDANT_DEPTH) {
      for (const child of children.get(process.pid) || []) {
        queue.push({ process: child, depth: depth + 1 });
      }
    }
  }

  return [...families];
}

export type ForegroundSurface = 'app' | 'cli';

/**
 * 'app' when the foreground process itself is a desktop app (a provider with
 * surface 'desktop': Claude.exe, Codex Desktop, Antigravity.exe), 'cli' when a
 * tool runs under it (a terminal host), null when no tool owns it.
 */
export function foregroundSurfaceForProcess(
  foregroundPid: number,
  processes: readonly ProcessInfo[],
  providers: readonly ToolProvider[]
): ForegroundSurface | null {
  const root = processes.find((process) => process.pid === foregroundPid);
  if (!root) {
    return null;
  }
  for (const provider of providers) {
    if (provider.process && provider.presence && provider.process.surface === 'desktop' && provider.process.matches(root)) {
      return 'app';
    }
  }
  return familiesForForegroundProcess(foregroundPid, processes, providers).length > 0 ? 'cli' : null;
}

/**
 * Finds the ONE tool family that owns the foreground window. Returns null
 * when the foreground process is not a known tool or when several tool
 * families share it (ambiguous split panes / terminal tabs); use
 * familiesForForegroundProcess to see the candidates.
 */
export function familyForForegroundProcess(
  foregroundPid: number,
  processes: readonly ProcessInfo[],
  providers: readonly ToolProvider[]
): ToolFamily | null {
  const families = familiesForForegroundProcess(foregroundPid, processes, providers);
  return families.length === 1 ? families[0] : null;
}

/**
 * Breaks a shared-host tie (Claude Code and Codex CLI in tabs of one
 * WindowsTerminal.exe): among the candidate families, the one whose hook
 * session reported most recently wins. Returns null when no candidate has hook
 * activity (ambiguity stays unresolved; never a process-timestamp guess).
 */
export function pickAmbiguousForegroundFamily<T extends { family?: ToolFamily; source?: string; updatedAt?: number | null }>(
  candidates: readonly ToolFamily[],
  tools: readonly T[],
  familyOf: (tool: T) => ToolFamily = (tool) => tool.family || 'other'
): ToolFamily | null {
  if (candidates.length < 2) {
    return candidates.length === 1 ? candidates[0] : null;
  }
  const allowed = new Set(candidates);
  let best: { family: ToolFamily; at: number } | null = null;
  for (const tool of tools) {
    if (!tool || tool.source !== 'hook') {
      continue;
    }
    const family = familyOf(tool);
    if (!allowed.has(family)) {
      continue;
    }
    const at = typeof tool.updatedAt === 'number' && Number.isFinite(tool.updatedAt) ? tool.updatedAt : 0;
    if (at > 0 && (!best || at > best.at)) {
      best = { family, at };
    }
  }
  return best ? best.family : null;
}

/**
 * Finds the ONE Muse process owned by the foreground window: the foreground
 * PID itself or a descendant (terminal -> shell -> agent, same depth bound as
 * family attribution). Returns null when the foreground hosts zero or
 * several Muse processes (shared terminal panes/siblings are ambiguous, never
 * resolved by newest-descendant heuristics) or when the PID is unknown.
 */
export function musePidForForegroundProcess(
  foregroundPid: number,
  processes: readonly ProcessInfo[],
  matches: (process: ProcessInfo | string) => boolean = isMuseProcess
): number | null {
  const byPid = new Map<number, ProcessInfo>();
  for (const process of processes) {
    byPid.set(process.pid, process);
  }

  const root = byPid.get(foregroundPid);
  if (!root) {
    return null;
  }

  const children = childrenByParent(processes);
  const queue: Array<{ process: ProcessInfo; depth: number }> = [{ process: root, depth: 0 }];
  const found = new Set<number>();

  while (queue.length > 0) {
    const { process, depth } = queue.shift() as { process: ProcessInfo; depth: number };

    try {
      if (matches(process)) {
        found.add(process.pid);
        if (found.size > 1) {
          return null;
        }
      }
    } catch (_) {
      return null;
    }

    if (depth < MAX_DESCENDANT_DEPTH) {
      for (const child of children.get(process.pid) || []) {
        queue.push({ process: child, depth: depth + 1 });
      }
    }
  }

  return found.size === 1 ? [...found][0] : null;
}
