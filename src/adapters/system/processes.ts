'use strict';

import { execFile } from 'node:child_process';
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

async function getWindowsProcessList(): Promise<ProcessInfo[]> {
  const filter = "Name='node.exe' OR Name='bun.exe' OR Name='claude.exe' OR Name='codex.exe' OR Name='ChatGPT.exe' OR Name='grok.exe' OR Name='Antigravity.exe' OR Name='Cursor.exe' OR Name='opencode.exe' OR Name='pi.exe' OR Name='pwsh.exe' OR Name='powershell.exe' OR Name='cmd.exe' OR Name='WindowsTerminal.exe' OR Name='conhost.exe' OR Name='OpenConsole.exe' OR Name LIKE 'muse%'";
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
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024
  }) as { stdout: string };

  return parseWindowsProcessListJson(stdout);
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
