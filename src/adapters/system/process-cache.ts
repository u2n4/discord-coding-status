'use strict';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessInfo } from '../../core/tools/types';
import { parseWindowsProcessListJson } from './processes';

// Cached process snapshot for the fast focus/hook/model path.
//
// The slow health census (10s) replaces the whole snapshot via
// setCachedProcessList. Fast passes NEVER call getProcessList; they read the
// cache and, only when the foreground PID is unknown, merge a small targeted
// CIM subtree (root + descendants, depth <= 4) with bounded dedup. No full
// census ever runs at sampler rate.

const execFileAsync = promisify(execFile);
const TARGETED_TIMEOUT_MS = 2000;
const TARGETED_MAX_BUFFER = 256 * 1024;
const REFRESH_DEDUP_TTL_MS = 2000;
const RETAINED_SUBTREE_TTL_MS = 60_000;
const MAX_REFRESH_DEPTH = 4;
const MAX_REFRESH_PROCESSES = 32;
const MAX_DEDUP_ENTRIES = 128;

const HOST_OR_AI_PROCESS_REGEX =
  /(?:windowsterminal|openconsole|conhost|pwsh|powershell|cmd\.exe|wt\.exe|wezterm|alacritty|mintty|cursor|code\.exe|claude|codex|chatgpt|grok|antigravity|muse|opencode|pi\.exe|node\.exe|bun\.exe)/i;

let cached: ProcessInfo[] = [];
let byPid = new Map<number, ProcessInfo>();
let cacheUpdatedAt = 0;

let refreshAttempts = 0;
let refreshSucceeded = 0;
let refreshDeduped = 0;
let lastRefreshMs = 0;

const inFlightByPid = new Map<number, Promise<ProcessInfo[]>>();
const lastAttemptByPid = new Map<number, number>();
const retainedSubtreeByPid = new Map<number, { processes: ProcessInfo[]; expiresAt: number }>();

export interface ProcessCacheStats {
  size: number;
  updatedAt: number;
  refreshAttempts: number;
  refreshSucceeded: number;
  refreshDeduped: number;
  lastRefreshMs: number;
  inFlight: number;
}

export function getCachedProcessList(): ProcessInfo[] {
  return cached;
}

export function getCachedProcessByPid(pid: number): ProcessInfo | null {
  return byPid.get(pid) || null;
}

export function setCachedProcessList(list: ProcessInfo[]): void {
  const now = Date.now();
  const nextByPid = new Map<number, ProcessInfo>();
  for (const process of list) {
    nextByPid.set(process.pid, process);
  }
  for (const [rootPid, entry] of retainedSubtreeByPid) {
    if (entry.expiresAt <= now) {
      retainedSubtreeByPid.delete(rootPid);
      continue;
    }
    for (const proc of entry.processes) {
      if (!nextByPid.has(proc.pid)) {
        nextByPid.set(proc.pid, proc);
      }
    }
  }
  cached = [...nextByPid.values()];
  byPid = nextByPid;
  cacheUpdatedAt = now;
}

export function getProcessCacheStats(): ProcessCacheStats {
  return {
    size: cached.length,
    updatedAt: cacheUpdatedAt,
    refreshAttempts,
    refreshSucceeded,
    refreshDeduped,
    lastRefreshMs,
    inFlight: inFlightByPid.size
  };
}

export function clearProcessCacheForTests(): void {
  cached = [];
  byPid = new Map<number, ProcessInfo>();
  cacheUpdatedAt = 0;
  retainedSubtreeByPid.clear();
}

export function resetProcessCacheStatsForTests(): void {
  refreshAttempts = 0;
  refreshSucceeded = 0;
  refreshDeduped = 0;
  lastRefreshMs = 0;
  inFlightByPid.clear();
  lastAttemptByPid.clear();
  retainedSubtreeByPid.clear();
}

function pruneDedupEntries(): void {
  if (lastAttemptByPid.size <= MAX_DEDUP_ENTRIES) {
    return;
  }

  const overflow = lastAttemptByPid.size - MAX_DEDUP_ENTRIES;
  const oldest = [...lastAttemptByPid.entries()].sort((left, right) => left[1] - right[1]);
  for (let index = 0; index < overflow; index += 1) {
    lastAttemptByPid.delete(oldest[index][0]);
  }
}

function upsertIntoCache(processes: ProcessInfo[]): void {
  if (!processes.length) {
    return;
  }

  const merged = new Map<number, ProcessInfo>(byPid);
  for (const process of processes) {
    merged.set(process.pid, process);
  }

  cached = [...merged.values()];
  byPid = merged;
}

async function queryWindowsProcesses(filter: string): Promise<ProcessInfo[]> {
  const command = [
    `@(Get-CimInstance Win32_Process -Filter "${filter}" |`,
    'Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,UserModeTime,KernelModeTime,CreationDate) |',
    'ConvertTo-Json -Compress'
  ].join(' ');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command
  ], {
    timeout: TARGETED_TIMEOUT_MS,
    maxBuffer: TARGETED_MAX_BUFFER
  }) as { stdout: string };

  return parseWindowsProcessListJson(stdout || '');
}

async function querySubtree(rootPid: number): Promise<ProcessInfo[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  const startedAt = Date.now();
  const collected: ProcessInfo[] = [];
  const seen = new Set<number>();

  try {
    const safeRoot = Math.floor(rootPid);
    const root = await queryWindowsProcesses(`ProcessId=${safeRoot}`);
    for (const process of root) {
      if (!seen.has(process.pid) && collected.length < MAX_REFRESH_PROCESSES) {
        seen.add(process.pid);
        collected.push(process);
      }
    }

    const canHaveAiDescendants = root.some((proc) => HOST_OR_AI_PROCESS_REGEX.test(proc.line));
    let frontier = canHaveAiDescendants ? root.map((process) => Math.floor(process.pid)) : [];
    for (let depth = 0; depth < MAX_REFRESH_DEPTH && frontier.length > 0; depth += 1) {
      const limited = frontier.slice(0, 8);
      const filter = limited.map((pid) => `ParentProcessId=${Math.floor(pid)}`).join(' OR ');
      const children = await queryWindowsProcesses(filter);
      const next: number[] = [];

      for (const child of children) {
        if (seen.has(child.pid) || collected.length >= MAX_REFRESH_PROCESSES) {
          continue;
        }

        seen.add(child.pid);
        collected.push(child);
        next.push(child.pid);
      }

      frontier = next;
      if (collected.length >= MAX_REFRESH_PROCESSES) {
        break;
      }
    }

    refreshSucceeded += 1;
    return collected;
  } finally {
    lastRefreshMs = Math.max(0, Date.now() - startedAt);
  }
}

// Merges the foreground subtree for an unknown PID into the cache. Known PIDs
// are cache hits (no spawn). Concurrent and recent repeat requests for the
// same PID are deduped to one underlying query.
export function refreshProcessForPid(pid: number): Promise<ProcessInfo[]> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return Promise.resolve([]);
  }

  if (byPid.has(pid)) {
    return Promise.resolve([]);
  }

  const now = Date.now();
  const retained = retainedSubtreeByPid.get(pid);
  if (retained && retained.expiresAt > now) {
    refreshDeduped += 1;
    return Promise.resolve(retained.processes);
  }

  const inFlight = inFlightByPid.get(pid);
  if (inFlight) {
    refreshDeduped += 1;
    return inFlight;
  }

  const lastAttempt = lastAttemptByPid.get(pid) || 0;
  if (now - lastAttempt < REFRESH_DEDUP_TTL_MS) {
    refreshDeduped += 1;
    return Promise.resolve([]);
  }

  if (process.platform !== 'win32') {
    return Promise.resolve([]);
  }

  lastAttemptByPid.set(pid, now);
  pruneDedupEntries();
  refreshAttempts += 1;

  const pending = querySubtree(pid)
    .then((processes) => {
      retainedSubtreeByPid.set(pid, {
        processes,
        expiresAt: Date.now() + RETAINED_SUBTREE_TTL_MS
      });
      upsertIntoCache(processes);
      return processes;
    })
    .catch(() => [] as ProcessInfo[])
    .finally(() => {
      if (inFlightByPid.get(pid) === pending) {
        inFlightByPid.delete(pid);
      }
    });

  inFlightByPid.set(pid, pending);
  return pending;
}
