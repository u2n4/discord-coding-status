'use strict';

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessInfo } from '../../core/tools/types';

const execFileAsync = promisify(execFile);
const PS_TIMEOUT_MS = 5_000;
const LSOF_TIMEOUT_MS = 2_000;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
    return code === 'EPERM';
  }
}

export async function getProcessList(): Promise<ProcessInfo[]> {
  if (process.platform === 'win32') {
    return getWindowsProcessList();
  }

  const { stdout } = await execFileAsync('ps', ['ax', '-o', 'pid=,time=,comm=,args='], {
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  }) as { stdout: string };

  return stdout
    .split('\n')
    .map(parseProcessLine)
    .filter((processInfo): processInfo is ProcessInfo => Boolean(processInfo));
}

// Shared CIM JSON parser: mirrors getWindowsProcessList row mapping so the
// targeted foreground refresh in process-cache reuses identical semantics.
export function parseWindowsProcessListJson(stdout: string): ProcessInfo[] {
  if (!stdout.trim()) {
    return [];
  }

  const parsed = JSON.parse(stdout) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  return rows
    .map((row): ProcessInfo | null => {
      const record = asRecord(row);
      const parsedPid = extractNumberLike(record?.ProcessId);
      if (parsedPid === null) {
        return null;
      }

      const parsedPpid = extractNumberLike(record?.ParentProcessId);
      const parsedCommandLine = extractString(record?.CommandLine);
      const parsedExecutablePath = extractString(record?.ExecutablePath);
      const parsedLine = [parsedExecutablePath, parsedCommandLine].filter(Boolean).join(' ');

      if (!parsedLine) {
        return null;
      }

      const parsedUserTicks = extractNumberLike(record?.UserModeTime) || 0;
      const parsedKernelTicks = extractNumberLike(record?.KernelModeTime) || 0;

      return {
        pid: parsedPid,
        ppid: parsedPpid ?? undefined,
        line: parsedLine,
        raw: parsedLine,
        executablePath: parsedExecutablePath,
        commandLine: parsedCommandLine,
        cpuMs: (parsedUserTicks + parsedKernelTicks) / 10_000,
        createdAtMs: parseCreationDate(record?.CreationDate)
      };
    })
    .filter((processInfo): processInfo is ProcessInfo => Boolean(processInfo));
}

const WINDOWS_CENSUS_FILTER = "Name='node.exe' OR Name='bun.exe' OR Name='claude.exe' OR Name='codex.exe' OR Name='ChatGPT.exe' OR Name='grok.exe' OR Name='Antigravity.exe' OR Name='agy.exe' OR Name='Cursor.exe' OR Name='opencode.exe' OR Name='pi.exe' OR Name='pwsh.exe' OR Name='powershell.exe' OR Name='cmd.exe' OR Name='WindowsTerminal.exe' OR Name='conhost.exe' OR Name='OpenConsole.exe' OR Name LIKE 'muse%'";
const WINDOWS_CENSUS_QUERY = [
  `@(Get-CimInstance Win32_Process -Filter "${WINDOWS_CENSUS_FILTER}" |`,
  'Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,UserModeTime,KernelModeTime,CreationDate) |',
  'ConvertTo-Json -Compress'
].join(' ');

async function getWindowsProcessListOneShot(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    WINDOWS_CENSUS_QUERY
  ], {
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024
  }) as { stdout: string };

  return parseWindowsProcessListJson(stdout);
}

// --- persistent census helper ----------------------------------------------
// Starting powershell.exe costs ~0.6 s of CPU, which dominated the daemon's
// footprint at one census every 10 s. The daemon (only the daemon: short CLI
// commands keep the one-shot path) keeps ONE PowerShell alive and asks it for
// each census over stdin. The helper exits by itself when the daemon's pipe
// closes, so it cannot outlive a crashed or killed daemon. Any failure falls
// back to the one-shot spawn; repeated failures disable the helper for a while.

const CENSUS_END_MARKER = '<<dcs-census-end>>';
const CENSUS_HELPER_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'while ($true) {',
  '  $request = [Console]::In.ReadLine()',
  '  if ($null -eq $request) { break }',
  `  try { $json = ${WINDOWS_CENSUS_QUERY}; if ($json) { [Console]::Out.WriteLine($json) } } catch { [Console]::Out.WriteLine("!" + $_.Exception.Message) }`,
  `  [Console]::Out.WriteLine("${CENSUS_END_MARKER}")`,
  '  [Console]::Out.Flush()',
  '}'
].join('\n');
const CENSUS_HELPER_FAILURE_LIMIT = 3;
const CENSUS_HELPER_COOLDOWN_MS = 10 * 60_000;

let persistentCensusEnabled = false;
let censusHelper: ChildProcessWithoutNullStreams | null = null;
let censusBuffer = '';
let censusPending: { resolve: (rows: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
let censusChain: Promise<unknown> = Promise.resolve();
let censusFailures = 0;
let censusDisabledUntil = 0;

export function enablePersistentProcessCensus(enabled = true): void {
  persistentCensusEnabled = enabled && process.platform === 'win32';
  if (!persistentCensusEnabled) {
    stopCensusHelper();
  }
}

export function stopCensusHelper(): void {
  const child = censusHelper;
  censusHelper = null;
  censusBuffer = '';
  if (censusPending) {
    clearTimeout(censusPending.timer);
    censusPending.reject(new Error('census helper stopped'));
    censusPending = null;
  }
  if (child) {
    try {
      child.stdin.end();
    } catch (_) {}
    try {
      child.kill();
    } catch (_) {}
  }
}

function startCensusHelper(): ChildProcessWithoutNullStreams {
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    CENSUS_HELPER_SCRIPT
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    censusBuffer += chunk;
    const markerAt = censusBuffer.indexOf(CENSUS_END_MARKER);
    if (markerAt < 0 || !censusPending) {
      return;
    }
    const body = censusBuffer.slice(0, markerAt).trim();
    censusBuffer = censusBuffer.slice(markerAt + CENSUS_END_MARKER.length).replace(/^\r?\n/, '');
    const pending = censusPending;
    censusPending = null;
    clearTimeout(pending.timer);
    if (body.startsWith('!')) {
      pending.reject(new Error(`census helper query failed: ${body.slice(1, 200)}`));
    } else {
      pending.resolve(body);
    }
  });
  child.stderr.resume();
  const onGone = () => {
    if (censusHelper === child) {
      censusHelper = null;
      censusBuffer = '';
    }
    if (censusPending) {
      const pending = censusPending;
      censusPending = null;
      clearTimeout(pending.timer);
      pending.reject(new Error('census helper exited'));
    }
  };
  child.on('exit', onGone);
  child.on('error', onGone);
  // Never keep the daemon's event loop alive on the helper's account.
  child.unref();
  (child.stdin as unknown as { unref?: () => void }).unref?.();
  (child.stdout as unknown as { unref?: () => void }).unref?.();
  (child.stderr as unknown as { unref?: () => void }).unref?.();
  return child;
}

function queryCensusHelper(): Promise<string> {
  const run = () => new Promise<string>((resolve, reject) => {
    if (!censusHelper) {
      censusHelper = startCensusHelper();
    }
    const child = censusHelper;
    const timer = setTimeout(() => {
      if (censusPending) {
        censusPending = null;
        reject(new Error('census helper timed out'));
      }
      // A wedged helper is replaced on the next request.
      if (censusHelper === child) {
        stopCensusHelper();
      }
    }, PS_TIMEOUT_MS);
    censusPending = { resolve, reject, timer };
    try {
      child.stdin.write('census\n');
    } catch (error) {
      clearTimeout(timer);
      censusPending = null;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  // One request at a time over the single pipe.
  const next = censusChain.then(run, run);
  censusChain = next.catch(() => {});
  return next;
}

async function getWindowsProcessList(): Promise<ProcessInfo[]> {
  if (persistentCensusEnabled && Date.now() >= censusDisabledUntil) {
    try {
      const rows = parseWindowsProcessListJson(await queryCensusHelper());
      censusFailures = 0;
      return rows;
    } catch (_) {
      censusFailures += 1;
      if (censusFailures >= CENSUS_HELPER_FAILURE_LIMIT) {
        censusFailures = 0;
        censusDisabledUntil = Date.now() + CENSUS_HELPER_COOLDOWN_MS;
        stopCensusHelper();
      }
    }
  }
  return getWindowsProcessListOneShot();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractNumberLike(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseCreationDate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1e12 && value < 1e13) {
    return Math.round(value);
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const text = value.trim();
  const netMatch = text.match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//);
  if (netMatch) {
    const millis = Number(netMatch[1]);
    return Number.isFinite(millis) && millis > 0 ? millis : undefined;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseProcessLine(line: string): ProcessInfo | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.+)$/);

  if (!match) {
    return null;
  }

  const pid = Number(match[1]);
  const cpuSeconds = parseCpuSeconds(match[2]);

  return {
    pid,
    line: match[3],
    raw: trimmed,
    cpuMs: cpuSeconds === null ? undefined : cpuSeconds * 1000
  };
}

function parseCpuSeconds(text: string): number | null {
  const value = String(text || '').trim();
  if (!value) {
    return null;
  }

  // ps prints cumulative CPU time as MM:SS.cc, HH:MM:SS[.cc], or D-HH:MM:SS[.cc]
  // when the process has accumulated a day or more of CPU time.
  let normalized = value;
  const dayMatch = normalized.match(/^(\d+)-(.+)$/);
  if (dayMatch) {
    normalized = `${Number(dayMatch[1]) * 24}:${dayMatch[2]}`;
  }

  const segments = normalized.split(':').map((segment) => {
    const [whole, fraction] = segment.split('.');
    const integer = Number(whole);
    const frac = fraction ? Number(`0.${fraction}`) : 0;
    return Number.isFinite(integer) ? integer + frac : NaN;
  });

  if (segments.some((segment) => Number.isNaN(segment)) || segments.length === 0) {
    return null;
  }

  let seconds = segments.pop() as number;
  let multiplier = 1;
  while (segments.length) {
    multiplier *= 60;
    seconds += (segments.pop() as number) * multiplier;
  }

  return seconds;
}

export async function getCwdForProcess(processInfo: ProcessInfo | undefined): Promise<string | null> {
  if (!processInfo || !processInfo.pid || process.platform === 'win32') {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('lsof', [
      '-a',
      '-p',
      String(processInfo.pid),
      '-d',
      'cwd',
      '-Fn'
    ], {
      timeout: LSOF_TIMEOUT_MS,
      maxBuffer: 64 * 1024
    }) as { stdout: string };

    const cwdLine = stdout
      .split('\n')
      .find((line) => line.startsWith('n'));

    return cwdLine ? cwdLine.slice(1).trim() : null;
  } catch (_) {
    return null;
  }
}
