'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shellQuoteArg } from './env';
import { envPathValue, resolveHomePath } from './commands/config/settings';
import { getArgString } from './commands/args';
import { readHookInput, sleepSync } from './state-store';
import {
  getAntigravityCliHomeDir,
  normalizeAntigravityModel,
  readActiveAntigravityModel,
  readAntigravityCliModel
} from './providers/antigravity/model';
import type { HookSessionState } from './core/hooks/types';

export const ANTIGRAVITY_MANAGED_HOOK_NAME = 'discord-coding-status';
export const ANTIGRAVITY_MANAGED_HOOK_MARKER = '--managed-by=discord-coding-status';

export const ANTIGRAVITY_HOOK_EVENTS = [
  'SessionStart',
  'PreInvocation',
  'PostInvocation',
  'Stop'
] as const;

const ANTIGRAVITY_HOOK_TIMEOUT_SECONDS = 5;

export const ANTIGRAVITY_HOOKS_DIR = resolveHomePath(
  envPathValue(
    'DISCORD_CODING_STATUS_ANTIGRAVITY_CONFIG_DIR',
    path.join(os.homedir(), '.gemini', 'config')
  )
);

export const ANTIGRAVITY_HOOKS_FILE = resolveHomePath(
  envPathValue(
    'DISCORD_CODING_STATUS_ANTIGRAVITY_HOOKS_FILE',
    path.join(ANTIGRAVITY_HOOKS_DIR, 'hooks.json')
  )
);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

// Windows hook commands are plain double-quoted cmd-compatible args with the
// absolute node binary (never bare `node`, which depends on the GUI app's
// PATH). Windows paths cannot contain `"`, so no escaping is needed; a
// backslash-escaped `\"` is not cmd quoting and would break the command.
function cmdQuoteArg(value: string): string {
  return `"${value}"`;
}

export function antigravityHookCommand(scriptPath: string, event: string): string {
  if (process.platform === 'win32') {
    return [
      cmdQuoteArg(process.execPath),
      cmdQuoteArg(scriptPath),
      'antigravity-hook',
      '--event',
      event,
      ANTIGRAVITY_MANAGED_HOOK_MARKER
    ].join(' ');
  }

  return [
    shellQuoteArg(process.execPath),
    shellQuoteArg(scriptPath),
    'antigravity-hook',
    '--event',
    shellQuoteArg(event),
    ANTIGRAVITY_MANAGED_HOOK_MARKER
  ].join(' ');
}

export function isManagedAntigravityHookHandler(handler: unknown): boolean {
  const record = asRecord(handler);
  const command = typeof record?.command === 'string' ? record.command : '';
  return command.includes(ANTIGRAVITY_MANAGED_HOOK_MARKER);
}

/**
 * Thrown when an existing hooks.json cannot be parsed as a JSON object
 * (JSONC comments, trailing commas, corruption). Writers must refuse to touch
 * the file: rewriting it from `{}` would delete the user's other hooks.
 */
export class AntigravityHooksParseError extends Error {
  constructor(filePath: string, cause: string) {
    super(
      `Refusing to modify ${filePath}: it is not a plain JSON object (${cause}). `
      + 'Fix or remove the file, then run the command again.'
    );
    this.name = 'AntigravityHooksParseError';
  }
}

/**
 * Strict read for writers: a missing file is `{}`, an unparsable or non-object
 * file throws AntigravityHooksParseError so nothing gets overwritten.
 */
export function readAntigravityHooksFileStrict(filePath = ANTIGRAVITY_HOOKS_FILE): JsonRecord {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new AntigravityHooksParseError(filePath, error instanceof Error ? error.name : 'parse error');
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new AntigravityHooksParseError(filePath, 'top level is not an object');
  }
  return record;
}

/** Lenient read for status reporting: unparsable files read as `{}`. */
export function readAntigravityHooksFile(filePath = ANTIGRAVITY_HOOKS_FILE): JsonRecord {
  try {
    return readAntigravityHooksFileStrict(filePath);
  } catch (_) {
    return {};
  }
}

const RENAME_ATTEMPTS = 10;
const RENAME_RETRYABLE = new Set(['EPERM', 'EACCES']);

// Windows transiently refuses to replace a file that a scanner, indexer, or the
// editor itself still has open (EPERM/EACCES). The rename stays atomic; only
// the attempt is retried with backoff, and the last error is rethrown.
function renameWithRetrySync(source: string, target: string): void {
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!RENAME_RETRYABLE.has(code || '') || attempt === RENAME_ATTEMPTS) {
        throw error;
      }
      sleepSync(25 * attempt);
    }
  }
}

/**
 * Atomic write (temp file + rename with EPERM/EACCES retry). Before the first
 * change, the existing file is copied to `<file>.bak` exactly once: an existing
 * backup is never overwritten, so re-runs cannot clobber the original.
 */
export function writeAntigravityHooksFile(filePath: string, config: JsonRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const backupFile = `${filePath}.bak`;
  if (fs.existsSync(filePath) && !fs.existsSync(backupFile)) {
    fs.copyFileSync(filePath, backupFile, fs.constants.COPYFILE_EXCL);
  }
  const tempFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    renameWithRetrySync(tempFile, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempFile);
    } catch (_) {
      // Best effort: never mask the original rename failure.
    }
    throw error;
  }
}

export interface ManagedAntigravityHookStatus {
  installed: boolean;
  managedCount: number;
  eventCounts: Record<string, number>;
  missingEvents: string[];
  duplicateEvents: string[];
  unexpectedEvents: string[];
}

export function getManagedAntigravityHookStatus(
  config: unknown = readAntigravityHooksFile(),
  expectedEvents: readonly string[] = ANTIGRAVITY_HOOK_EVENTS
): ManagedAntigravityHookStatus {
  const root = asRecord(config) ?? {};
  const eventCounts: Record<string, number> = {};
  let managedCount = 0;

  for (const [, hookGroupValue] of Object.entries(root)) {
    const hookGroup = asRecord(hookGroupValue);
    if (!hookGroup || hookGroup.enabled === false) {
      continue;
    }
    for (const [eventName, handlersValue] of Object.entries(hookGroup)) {
      if (!Array.isArray(handlersValue)) {
        continue;
      }
      const count = handlersValue.filter(isManagedAntigravityHookHandler).length;
      if (count > 0) {
        eventCounts[eventName] = (eventCounts[eventName] ?? 0) + count;
        managedCount += count;
      }
    }
  }

  const expected = [...expectedEvents];
  const expectedSet = new Set(expected);
  const missingEvents = expected.filter((eventName) => !eventCounts[eventName]);
  const duplicateEvents = expected.filter((eventName) => (eventCounts[eventName] ?? 0) > 1);
  const unexpectedEvents = Object.keys(eventCounts).filter((eventName) => !expectedSet.has(eventName));

  return {
    installed: expected.length > 0
      && missingEvents.length === 0
      && duplicateEvents.length === 0
      && unexpectedEvents.length === 0,
    managedCount,
    eventCounts,
    missingEvents,
    duplicateEvents,
    unexpectedEvents
  };
}

export function removeManagedAntigravityHooks(
  config: unknown = readAntigravityHooksFileStrict()
): { config: JsonRecord; removed: number } {
  const root = asRecord(config) ?? {};
  const nextRoot: JsonRecord = {};
  let removed = 0;

  for (const [groupName, groupValue] of Object.entries(root)) {
    const group = asRecord(groupValue);
    if (!group) {
      nextRoot[groupName] = groupValue;
      continue;
    }

    const nextGroup: JsonRecord = {};
    for (const [key, value] of Object.entries(group)) {
      if (!Array.isArray(value)) {
        nextGroup[key] = value;
        continue;
      }
      const filtered = value.filter((item) => {
        const managed = isManagedAntigravityHookHandler(item);
        if (managed) {
          removed += 1;
        }
        return !managed;
      });
      if (filtered.length > 0) {
        nextGroup[key] = filtered;
      }
    }

    const remainingEventArrays = Object.values(nextGroup).some((val) => Array.isArray(val));
    if (groupName !== ANTIGRAVITY_MANAGED_HOOK_NAME || remainingEventArrays) {
      if (Object.keys(nextGroup).length > 0) {
        nextRoot[groupName] = nextGroup;
      }
    }
  }

  return { config: nextRoot, removed };
}

export function installManagedAntigravityHooks(
  scriptPath: string,
  config: unknown = readAntigravityHooksFileStrict(),
  events: readonly string[] = ANTIGRAVITY_HOOK_EVENTS
): { config: JsonRecord; installed: number; removed: number; hooksFile: string } {
  const cleaned = removeManagedAntigravityHooks(config);
  const nextRoot: JsonRecord = { ...cleaned.config };
  const managedSpec: JsonRecord = {};
  let installed = 0;

  for (const eventName of events) {
    managedSpec[eventName] = [
      {
        type: 'command',
        command: antigravityHookCommand(scriptPath, eventName),
        timeout: ANTIGRAVITY_HOOK_TIMEOUT_SECONDS
      }
    ];
    installed += 1;
  }

  nextRoot[ANTIGRAVITY_MANAGED_HOOK_NAME] = managedSpec;
  writeAntigravityHooksFile(ANTIGRAVITY_HOOKS_FILE, nextRoot);

  return {
    config: nextRoot,
    installed,
    removed: cleaned.removed,
    hooksFile: ANTIGRAVITY_HOOKS_FILE
  };
}

export function isAntigravityCliConversation(conversationId: string, transcriptPath: string | null): boolean {
  const cliHome = path.resolve(getAntigravityCliHomeDir()).toLowerCase();
  if (transcriptPath && path.resolve(transcriptPath).toLowerCase().startsWith(cliHome + path.sep)) {
    return true;
  }
  if (!conversationId || !/^[A-Za-z0-9-]{8,64}$/.test(conversationId)) {
    return false;
  }
  try {
    return fs.existsSync(path.join(getAntigravityCliHomeDir(), 'conversations', `${conversationId}.db`));
  } catch (_) {
    return false;
  }
}

export function antigravityHookSessionFromArgs(
  args: Record<string, string | boolean>
): HookSessionState {
  const input = readHookInput();
  const event = String(
    getArgString(args, 'event')
    || input.hook_event_name
    || input.event
    || ''
  ).trim();

  const conversationId = String(
    getArgString(args, 'session-id')
    || getArgString(args, 'session_id')
    || input.conversationId
    || input.session_id
    || ''
  ).trim();

  const workspacePaths = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
  const firstWorkspace = typeof workspacePaths[0] === 'string' ? workspacePaths[0].trim() : '';
  const cwd = String(
    getArgString(args, 'cwd')
    || firstWorkspace
    || input.cwd
    || process.cwd()
  ).trim();

  const transcriptPath = typeof input.transcriptPath === 'string'
    ? input.transcriptPath.trim()
    : (typeof input.transcript_path === 'string' ? input.transcript_path.trim() : null);

  let status = 'working';
  let activity = 'Working in Antigravity';
  switch (event) {
    case 'SessionStart':
      status = 'idle';
      activity = 'Ready in Antigravity';
      break;
    case 'PreInvocation':
      status = 'thinking';
      activity = 'Thinking in Antigravity';
      break;
    case 'PostInvocation':
      status = 'working';
      activity = 'Working in Antigravity';
      break;
    case 'Stop':
      status = 'idle';
      activity = 'Waiting for input';
      break;
    case 'SessionEnd':
      status = 'stopped';
      activity = 'Stopped';
      break;
    default:
      break;
  }

  // The Antigravity CLI (agy) loads the same hooks.json; its conversations and
  // transcripts live under ~/.gemini/antigravity-cli, the app's under
  // ~/.gemini/antigravity. Each surface reads its own model source.
  const fromCli = isAntigravityCliConversation(conversationId, transcriptPath);
  const rawModel = getArgString(args, 'model')
    || (typeof input.modelName === 'string' ? input.modelName : '')
    || (typeof input.model === 'string' ? input.model : '');
  const model = normalizeAntigravityModel(rawModel)
    || (fromCli ? readAntigravityCliModel()?.model : readActiveAntigravityModel(transcriptPath)?.model)
    || undefined;

  const now = Date.now();
  return {
    session_id: conversationId || `antigravity:${cwd || 'default'}`,
    tool: 'antigravity',
    surface: fromCli ? 'cli' : 'desktop',
    cwd,
    status,
    activity,
    ...(model ? { model } : {}),
    started_at: now,
    updated_at: now
  };
}
