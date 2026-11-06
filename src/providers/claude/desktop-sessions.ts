'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProcessInfo } from '../../core/tools/types';

// Claude Desktop keeps one record per Code-tab session in
// claude-code-sessions/<account>/<organization>/local_<id>.json: the model it
// runs, the Claude Code session id, and when the user last opened or typed in
// it. Records are parsed once per file version, so a read is a directory walk
// and a stat of each file, about 300 of them here.

export interface ClaudeDesktopSession {
  sessionId: string;
  model: string | null;
  focusedAtMs: number;
  usedAtMs: number;
}

interface CachedSession {
  mtimeMs: number;
  session: ClaudeDesktopSession | null;
}

// Leaving one session for another stamps both, milliseconds apart.
const SAME_VIEW_CHANGE_MS = 1_000;

// Records exist but cannot name one session: the caller shows no model.
const UNKNOWN_SESSION: ClaudeDesktopSession = { sessionId: '', model: null, focusedAtMs: 0, usedAtMs: 0 };

let cache = new Map<string, CachedSession>();

// A running Desktop names its data folder on its command line. Version
// 4.23118 moved that folder, so the live value comes before any fixed path.
// Only Desktop's Chromium helpers count, and only as a whole argument with a
// local path. Another claude.exe can carry this text inside a prompt, Desktop's
// own command line can carry a link it was opened with, and reading a network
// path would make Windows authenticate to that host.
function runningDataDirs(desktopPid: number, processes: ProcessInfo[]): string[] {
  const exe = (proc?: ProcessInfo) => String(proc?.executablePath || '').trim().toLowerCase();
  const desktopExe = exe(processes.find((proc) => proc.pid === desktopPid));
  const localPath = process.platform === 'win32' ? /^[A-Za-z]:[\\/]/ : /^\/(?!\/)/;
  const dirs = new Set<string>();
  for (const proc of processes) {
    if (desktopExe && proc.ppid === desktopPid && exe(proc) === desktopExe) {
      const args = String(proc.commandLine || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      const flag = args.find((arg) => arg.startsWith('--user-data-dir='));
      const dir = flag ? flag.slice('--user-data-dir='.length).replace(/"/g, '') : '';
      if (args.some((arg) => arg.startsWith('--type=')) && localPath.test(dir)) {
        dirs.add(dir);
      }
    }
  }
  return [...dirs];
}

function sessionRoots(desktopPid: number, processes: ProcessInfo[]): string[] {
  const override = String(process.env.DISCORD_CODING_STATUS_CLAUDE_DESKTOP_SESSIONS || '').trim();
  if (override) {
    return [override];
  }
  const running = runningDataDirs(desktopPid, processes);
  if (running.length) {
    return running.map((dir) => path.join(dir, 'claude-code-sessions'));
  }
  const roots: string[] = [];
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  roots.push(path.join(appData, 'Claude', 'claude-code-sessions'));
  // The Store build keeps the same folder inside its package.
  const packages = path.join(localAppData, 'Packages');
  for (const name of listDirectories(packages)) {
    if (/^Claude_/i.test(name)) {
      roots.push(path.join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions'));
    }
  }
  return roots;
}

function listDirectories(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (_) {
    return [];
  }
}

function sessionFiles(root: string): string[] {
  const files: string[] = [];
  for (const account of listDirectories(root)) {
    for (const organization of listDirectories(path.join(root, account))) {
      const dir = path.join(root, account, organization);
      try {
        for (const name of fs.readdirSync(dir)) {
          if (/^local_.*\.json$/i.test(name)) {
            files.push(path.join(dir, name));
          }
        }
      } catch (_) {
        // The folder went away between the two listings.
      }
    }
  }
  return files;
}

// Throws when the file cannot be read or parsed; null means an archived session.
function parseSession(file: string): ClaudeDesktopSession | null {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.isArchived === true) {
    return null;
  }
  // A session gets its Claude Code id on its first run; until then the id is empty.
  const sessionId = typeof record.cliSessionId === 'string' ? record.cliSessionId.trim() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  const validModel = /^[A-Za-z0-9][A-Za-z0-9._:@\[\]-]{0,80}$/.test(model) && model !== 'default';
  const focusedAtMs = Number(record.lastFocusedAt) || 0;
  const usedAtMs = Math.max(focusedAtMs, Number(record.latestUserFrameAt) || 0);
  return { sessionId, model: validModel ? model : null, focusedAtMs, usedAtMs };
}

function newestUsed(sessions: ClaudeDesktopSession[]): ClaudeDesktopSession {
  return sessions.reduce((best, session) => (session.usedAtMs > best.usedAtMs ? session : best));
}

/**
 * Picks the session in use. A delivered message moves latestUserFrameAt as
 * typing does (a subagent's report, for one), and typing in a split-view pane
 * does not move lastFocusedAt. So a session that leads only through a message,
 * outside the last view change, could be either: it stands only when the
 * session opened last has the same model. Equal stamps must agree too. The two
 * sessions of one view change are not compared: both may be on screen, and
 * comparing them would blank the label after every switch between two models.
 */
function pickSession(sessions: ClaudeDesktopSession[], unreadableMtimeMs: number): ClaudeDesktopSession | null {
  const used = sessions.filter((session) => session.usedAtMs > 0);
  if (!used.length) {
    return unreadableMtimeMs > 0 ? UNKNOWN_SESSION : null;
  }
  const latest = newestUsed(used);
  // A record written after that stamp and unreadable now may be the one in use.
  if (unreadableMtimeMs > latest.usedAtMs) {
    return UNKNOWN_SESSION;
  }
  const lastFocusAtMs = used.reduce((newest, session) => Math.max(newest, session.focusedAtMs), 0);
  const opened = used.filter((session) => session.focusedAtMs >= lastFocusAtMs - SAME_VIEW_CHANGE_MS);
  const rivals = used.filter((session) => session.usedAtMs === latest.usedAtMs);
  if (!opened.includes(latest)) {
    rivals.push(newestUsed(opened));
  }
  const agreed = rivals.every((session) => session === latest || (session.model !== null && session.model === latest.model));
  return agreed ? latest : UNKNOWN_SESSION;
}

/**
 * The Code-tab session the user opened or typed in last, or a session with no
 * id and no model when the records cannot name one. A session's own work does
 * not move these stamps, so a long run elsewhere cannot take the label.
 */
export function readLastUsedClaudeDesktopSession(desktopPid = 0, processes: ProcessInfo[] = []): ClaudeDesktopSession | null {
  const next = new Map<string, CachedSession>();
  const sessions: ClaudeDesktopSession[] = [];
  let unreadableMtimeMs = 0;
  for (const root of sessionRoots(desktopPid, processes)) {
    for (const file of sessionFiles(root)) {
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch (error) {
        // A deleted session is gone; any other failure hides a possible one in use.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          unreadableMtimeMs = Infinity;
        }
        continue;
      }
      let entry = cache.get(file);
      if (!entry || entry.mtimeMs !== mtimeMs) {
        try {
          entry = { mtimeMs, session: parseSession(file) };
        } catch (_) {
          // Not cached: the next read tries again, whatever the mtime says.
          unreadableMtimeMs = Math.max(unreadableMtimeMs, mtimeMs);
          continue;
        }
      }
      next.set(file, entry);
      if (entry.session) {
        sessions.push(entry.session);
      }
    }
  }
  cache = next;
  return pickSession(sessions, unreadableMtimeMs);
}
