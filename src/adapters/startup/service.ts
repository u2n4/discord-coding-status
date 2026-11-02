'use strict';

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DaemonRefreshResult } from './types';

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function getMacLaunchAgentPath(launchAgentId: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchAgentId}.plist`);
}

export function installMacLaunchAgent(
  scriptPath: string,
  startNow: boolean,
  options: { launchAgentId: string; logDirectory: string }
): string {
  const plistPath = getMacLaunchAgentPath(options.launchAgentId);
  const launchAgentsDir = path.dirname(plistPath);
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(options.logDirectory, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(options.launchAgentId)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(path.dirname(scriptPath))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(options.logDirectory, 'discord-coding-status.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(options.logDirectory, 'discord-coding-status.error.log'))}</string>
</dict>
</plist>
`;

  fs.writeFileSync(plistPath, plist);

  if (startNow) {
    const domain = `gui/${process.getuid ? process.getuid() : ''}`;
    try {
      execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    } catch (_) {}

    try {
      execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'ignore' });
    } catch (_) {
      execFileSync('launchctl', ['load', plistPath], { stdio: 'ignore' });
    }
  }

  return plistPath;
}

export interface WindowsLauncherPaths {
  commandPath: string;
  hiddenPath: string;
}

export function windowsLauncherPaths(installDirectory: string, appId: string): WindowsLauncherPaths {
  return {
    commandPath: path.join(installDirectory, 'run-daemon.cmd'),
    hiddenPath: path.join(installDirectory, `${appId}.vbs`)
  };
}

/**
 * Carries the Windows launchers across a runtime-directory replacement.
 *
 * `copyRuntimeToInstallDir` swaps the whole install directory, which would
 * otherwise delete `run-daemon.cmd` and the hidden `.vbs` the scheduled task
 * points at (this is how `hooks setup` broke the task with LastTaskResult=1).
 * Full `setup` rewrites both files afterwards via `installStartup`; this
 * preservation keeps every other runtime-copy path runnable too.
 */
export function preserveWindowsLaunchers(
  installDirectory: string,
  tempDirectory: string,
  appId: string
): void {
  const current = windowsLauncherPaths(installDirectory, appId);
  const next = windowsLauncherPaths(tempDirectory, appId);

  for (const [source, target] of [
    [current.commandPath, next.commandPath],
    [current.hiddenPath, next.hiddenPath]
  ] as const) {
    if (fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
}

/**
 * Extracts the launcher path from `schtasks /Query /XML` output. The task
 * action runs `wscript.exe "<vbs path>"`, so the VBS path sits in the
 * `<Arguments>` element of the `<Exec>` action. Returns null when the output
 * cannot be parsed (never throws: status reporting must stay honest but cheap).
 */
export function parseWindowsTaskActionTarget(xml: string): string | null {
  const match = xml.match(/<Arguments>([\s\S]*?)<\/Arguments>/i);
  if (!match) {
    return null;
  }

  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
    .replace(/^"+|"+$/g, '')
    .trim();

  return decoded || null;
}

/**
 * Resolves the on-disk target of a Windows scheduled task action, or null
 * when it cannot be determined. Used by `status`/`startup-status` so a task
 * whose launcher file is gone reports Broken instead of Active.
 */
export function queryWindowsTaskTarget(taskName: string): string | null {
  if (process.platform !== 'win32') {
    return null;
  }

  try {
    const output = execFileSync('schtasks', ['/Query', '/TN', taskName, '/XML'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return parseWindowsTaskActionTarget(typeof output === 'string' ? output : String(output));
  } catch (_) {
    return null;
  }
}

function queryWindowsTaskXml(taskName: string): string | null {
  if (process.platform !== 'win32') {
    return null;
  }
  try {
    const output = execFileSync('schtasks', ['/Query', '/TN', taskName, '/XML'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return typeof output === 'string' ? output : String(output);
  } catch (_) {
    return null;
  }
}

/**
 * True only when an existing task is exactly what setup would create: enabled
 * (no `<Enabled>false</Enabled>` on the task or its trigger), started by a
 * logon trigger, running `wscript.exe` on this launcher. Anything else is
 * re-created.
 */
export function isHealthyLauncherTask(xml: string | null, hiddenPath: string): boolean {
  if (!xml) {
    return false;
  }
  if (/<Enabled>\s*false\s*<\/Enabled>/i.test(xml) || !/<LogonTrigger\b/i.test(xml)) {
    return false;
  }
  const command = xml.match(/<Command>([\s\S]*?)<\/Command>/i)?.[1]?.trim().replace(/^"+|"+$/g, '') || '';
  if (path.win32.basename(command).toLowerCase() !== 'wscript.exe') {
    return false;
  }
  const target = parseWindowsTaskActionTarget(xml);
  return Boolean(target)
    && path.win32.resolve(target as string).toLowerCase() === path.win32.resolve(hiddenPath).toLowerCase();
}

/** Daemon log size that triggers rotation to `<name>.1` at the next launch. */
export const LOG_ROTATE_MAX_BYTES = 1024 * 1024;

export function writeWindowsLauncher(
  scriptPath: string,
  options: { installDirectory: string; logDirectory: string }
): string {
  const launcherPath = path.join(options.installDirectory, 'run-daemon.cmd');
  fs.mkdirSync(options.installDirectory, { recursive: true });
  fs.mkdirSync(options.logDirectory, { recursive: true });

  const outLog = path.join(options.logDirectory, 'discord-coding-status.log');
  const errLog = path.join(options.logDirectory, 'discord-coding-status.error.log');
  const content = [
    '@echo off',
    // Log rotation: the redirect below holds both files open for the
    // daemon's lifetime (Windows cannot rename them then), so rotate here,
    // before they are opened. Over LOG_ROTATE_MAX_BYTES -> <name>.1 (one old
    // file kept, replaced on the next rotation).
    `for %%F in ("${outLog}" "${errLog}") do if exist "%%~F" if %%~zF GTR ${LOG_ROTATE_MAX_BYTES} move /y "%%~F" "%%~F.1" >nul 2>&1`,
    `cd /d "${path.dirname(scriptPath)}"`,
    `"${process.execPath}" "${scriptPath}" daemon >> "${outLog}" 2>> "${errLog}"`
  ].join('\r\n') + '\r\n';

  fs.writeFileSync(launcherPath, content);
  return launcherPath;
}

function windowsQuotedArg(value: string): string {
  return value.includes(' ') || value.includes('"')
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

export function writeWindowsHiddenLauncher(
  launcherPath: string,
  options: { installDirectory: string; appId: string }
): string {
  const vbsPath = windowsLauncherPaths(options.installDirectory, options.appId).hiddenPath;
  const escaped = launcherPath.replace(/"/g, '""');
  fs.writeFileSync(vbsPath, [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${escaped}", 0, False`
  ].join('\r\n') + '\r\n');
  return vbsPath;
}

// PowerShell -match pattern for a node/bun command line whose script is
// <...discord-coding-status...>\dist\cli.js followed by the `daemon` argument.
// Used by setup's stop step; it contains no single quote, so it can sit inside a
// single-quoted PowerShell string as-is.
// Interpreter token, then the SCRIPT token itself (one quoted token, or one
// token without spaces), then `daemon`: a path that merely appears in a later
// argument of some other script can never match.
export const DAEMON_COMMAND_LINE_PATTERN = String.raw`^\s*(?:"[^"]*[\\/](?:node|bun)(?:\.exe)?"|(?:[^\s"]*[\\/])?(?:node|bun)(?:\.exe)?)\s+(?:"[^"]*discord-coding-status[^"]*[\\/]dist[\\/]cli\.js"|[^\s"]*discord-coding-status[^\s"]*[\\/]dist[\\/]cli\.js)\s+daemon(?:\s|$)`;

/**
 * Bound for the elevated `schtasks /Create` retry. `Start-Process -Wait`
 * blocks until the UAC prompt is answered, which never happens in a
 * non-interactive session; without a timeout a denied-or-absent click hangs
 * setup forever with the daemon already stopped. 120s still leaves an
 * interactive user ample time to approve.
 */
const ELEVATED_TASK_CREATE_TIMEOUT_MS = 120_000;

export function installWindowsScheduledTask(
  scriptPath: string,
  startNow: boolean,
  options: { taskName: string; installDirectory: string; logDirectory: string; appId: string }
): string {
  const launcherPath = writeWindowsLauncher(scriptPath, options);
  const hiddenPath = writeWindowsHiddenLauncher(launcherPath, options);
  const args = [
    '/Create',
    '/TN',
    options.taskName,
    '/SC',
    'ONLOGON',
    '/TR',
    `wscript.exe ${windowsQuotedArg(hiddenPath)}`,
    '/F'
  ];

  // The launchers were just rewritten in place, so a task that already points
  // at this VBS needs no change. Re-creating it anyway fails with "Access is
  // denied" when the existing task was registered elevated, and the elevated
  // retry then blocks setup on a UAC prompt for nothing.
  const alreadyRegistered = isHealthyLauncherTask(queryWindowsTaskXml(options.taskName), hiddenPath);

  if (!alreadyRegistered) try {
    execFileSync('schtasks', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const detail = (error && typeof error === 'object' && 'stderr' in error)
      ? String((error as { stderr?: Buffer | string }).stderr || '').trim()
      : '';

    try {
      const argumentList = args.map((arg) => (arg.startsWith('"') ? arg : `"${arg}"`)).join(' ');
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Start-Process -FilePath schtasks -ArgumentList '${argumentList}' -Verb RunAs -Wait`
      ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: ELEVATED_TASK_CREATE_TIMEOUT_MS });
    } catch (elevationError) {
      const elevationDetail = (elevationError && typeof elevationError === 'object' && 'stderr' in elevationError)
        ? String((elevationError as { stderr?: Buffer | string }).stderr || '').trim()
        : '';
      throw new Error(
        `Failed to create the scheduled task (${detail || 'Access is denied'}. `
        + `Run setup from an Administrator terminal, or accept the UAC prompt.`
        + `${elevationDetail ? ` Elevated attempt failed: ${elevationDetail}` : ''}`
        + `${(elevationError as { code?: string }).code === 'ETIMEDOUT' ? ' Elevated attempt timed out waiting for the UAC prompt.' : ''})`
      );
    }
  }

  if (startNow) {
    try {
      execFileSync('schtasks', ['/End', '/TN', options.taskName], { stdio: 'ignore' });
    } catch (_) {}
    try {
      execFileSync('schtasks', ['/Run', '/TN', options.taskName], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (_) {}
  }

  return options.taskName;
}

export function restartManagedDaemon(
  options: {
    macosLaunchAgentId: string;
    windowsTaskName: string;
    skipRestart?: boolean;
    /**
     * Windows: stops the running daemon before `/Run`. Required because the
     * task action (hidden VBS, `shell.Run ..., 0, False`) returns at once, so
     * the task is already "Ready" and `/End` stops nothing; the new daemon
     * would then see the live lock and exit.
     */
    stopDaemon?: () => void;
  }
): DaemonRefreshResult {
  if (options.skipRestart) {
    return { status: 'skipped' };
  }

  if (process.platform === 'darwin') {
    const plistPath = getMacLaunchAgentPath(options.macosLaunchAgentId);
    if (!fs.existsSync(plistPath)) {
      return { status: 'not-installed' };
    }

    const domain = `gui/${process.getuid ? process.getuid() : ''}`;
    const serviceTarget = `${domain}/${options.macosLaunchAgentId}`;
    try {
      execFileSync('launchctl', ['kickstart', '-k', serviceTarget], { stdio: 'ignore' });
      return { status: 'restarted' };
    } catch (_) {
      try {
        execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'ignore' });
        execFileSync('launchctl', ['kickstart', '-k', serviceTarget], { stdio: 'ignore' });
        return { status: 'restarted' };
      } catch (error) {
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Query', '/TN', options.windowsTaskName], { stdio: 'ignore' });
    } catch (_) {
      return { status: 'not-installed' };
    }

    try {
      try {
        execFileSync('schtasks', ['/End', '/TN', options.windowsTaskName], { stdio: 'ignore' });
      } catch (_) {}
      options.stopDaemon?.();
      execFileSync('schtasks', ['/Run', '/TN', options.windowsTaskName], { stdio: 'ignore' });
      return { status: 'restarted' };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return { status: 'unsupported' };
}
