'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shellQuoteArg } from './env';
import { envPathValue, resolveHomePath } from './commands/config/settings';
import { getArgString } from './commands/args';
import { readHookInput } from './state-store';
import {
  normalizeAntigravityModel,
  readActiveAntigravityModel
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

function cmdQuoteArg(value: string): string {
  if (!value.includes(' ')) {
    return value.replace(/\\/g, '/');
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function antigravityHookCommand(scriptPath: string, event: string): string {
  if (process.platform === 'win32') {
    return [
      'node',
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

export function readAntigravityHooksFile(filePath = ANTIGRAVITY_HOOKS_FILE): JsonRecord {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return asRecord(parsed) || {};
  } catch (_) {
    return {};
  }
}

export function writeAntigravityHooksFile(filePath: string, config: JsonRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch (_) {
      // Ignore backup failures.
    }
  }
  const tempFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempFile, filePath);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch (_) {
      // Already renamed.
    }
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
  config: unknown = readAntigravityHooksFile()
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
  config: unknown = readAntigravityHooksFile(),
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

  const rawModel = getArgString(args, 'model')
    || (typeof input.modelName === 'string' ? input.modelName : '')
    || (typeof input.model === 'string' ? input.model : '');
  const model = normalizeAntigravityModel(rawModel)
    || readActiveAntigravityModel(transcriptPath)?.model
    || undefined;

  const now = Date.now();
  return {
    session_id: conversationId || `antigravity:${cwd || 'default'}`,
    tool: 'antigravity',
    surface: 'desktop',
    cwd,
    status,
    activity,
    ...(model ? { model } : {}),
    started_at: now,
    updated_at: now
  };
}
