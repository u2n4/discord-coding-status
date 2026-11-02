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

export function writeWindowsLauncher(
  scriptPath: string,
  options: { installDirectory: string; logDirectory: string }
): string {
  const launcherPath = path.join(options.installDirectory, 'run-daemon.cmd');
  fs.mkdirSync(options.installDirectory, { recursive: true });
  fs.mkdirSync(options.logDirectory, { recursive: true });

  const content = [
    '@echo off',
    `cd /d "${path.dirname(scriptPath)}"`,
    `"${process.execPath}" "${scriptPath}" daemon >> "${path.join(options.logDirectory, 'discord-coding-status.log')}" 2>> "${path.join(options.logDirectory, 'discord-coding-status.error.log')}"`
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

  try {
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
