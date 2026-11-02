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
 * Finds the tool family that owns the foreground window. Terminal-hosted CLI
 * sessions own no window themselves, so descendants of the foreground PID
 * (terminal -> shell -> agent, a few levels deep) are considered as well.
 * Returns null when the foreground process is not a known tool or when
 * several tool families share it (ambiguous split panes).
 */
export function familyForForegroundProcess(
  foregroundPid: number,
  processes: readonly ProcessInfo[],
  providers: readonly ToolProvider[]
): ToolFamily | null {
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

  return families.size === 1 ? [...families][0] : null;
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
