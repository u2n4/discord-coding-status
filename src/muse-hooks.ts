import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shellQuoteArg } from './env';
import { envPathValue, resolveHomePath } from './commands/config/settings';
import { getArgString } from './commands/args';
import { readHookInput, readStateFile } from './state-store';
import { isProcessAlive } from './adapters/system/processes';
import { isMuseBinaryBasename } from './core/detection/tool-detection';
import type { HookSessionState } from './core/hooks/types';

// Native Muse Code lifecycle hooks (standalone user settings, no plugin).
//
// Standalone configuration: `$XDG_CONFIG_HOME/muse/settings.json`, default
// `~/.config/muse/settings.json`, with `schema_version: 1`. The documented
// stdin carries `hook_event_name`, `session_id`, `model` (the model in use),
// and nullable `transcript_path`; no PID key exists, so the owning Muse
// process is derived from the receiver's own ancestor chain instead.
//
// Privacy: the bridge reads ONLY top-level event/session/model metadata. It
// never reads prompts, messages, tool inputs/outputs, transcript content, or
// any process command line. Ancestor identification uses a bounded query-only
// CIM walk (ProcessId/ParentProcessId/Name/ExecutablePath/CreationDate).

export const MUSE_MANAGED_HOOK_MARKER = '--managed-by=discord-coding-status';

export const MUSE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreLLMCall',
  'PostLLMCall',
  'SessionEnd'
] as const;

export const MUSE_SETTINGS_SCHEMA_VERSION = 1;

const MUSE_HOOK_TIMEOUT_SECONDS = 5;
const MUSE_BINDER_DEPTH = 8;
const MUSE_BINDER_TIMEOUT_MS = 3000;
// Minimum spacing between ancestor walks for a session whose last walk found
// no Muse process, on events fired per LLM call (PreLLMCall/PostLLMCall).
const MUSE_BIND_RETRY_MS = 5 * 60 * 1000;

// Persisted alongside the session (state upsert spreads extra fields through):
// Unix ms of the last ancestor walk that found no owning Muse process.
type MuseHookSessionState = HookSessionState & { museBindAttemptedAt?: number };

// Human-paced events always retry the walk; per-LLM-call events honour the
// negative result until MUSE_BIND_RETRY_MS has passed.
function isMuseBindRetryEvent(event: string): boolean {
  const normalized = event.trim().toLowerCase().replace(/_/g, '');
  return normalized === 'sessionstart' || normalized === 'userpromptsubmit';
}

function defaultMuseConfigDir(): string {
  const xdg = (process.env.XDG_CONFIG_HOME || '').trim();
  if (xdg) {
    return resolveHomePath(xdg);
  }
  return path.join(os.homedir(), '.config');
}

export const MUSE_SETTINGS_FILE = resolveHomePath(
  envPathValue(
    'DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE',
    path.join(defaultMuseConfigDir(), 'muse', 'settings.json')
  )
);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

function uniqueEvents(events: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const eventName of events) {
    const normalized = eventName.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }

  return unique;
}

function cmdQuoteArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

// Muse on Windows dispatches hook commands through cmd.exe (proven receiver
// ancestry: node <- cmd <- muse-bin), so the Windows form is plain
// double-quoted args — never a PowerShell call operator, which cmd cannot
// parse. Both `command` and `commandWindows` carry the owner marker.
export function museHookCommandWindows(scriptPath: string, event: string): string {
  return [
    cmdQuoteArg(process.execPath),
    cmdQuoteArg(scriptPath),
    'muse-hook',
    '--event',
    event,
    MUSE_MANAGED_HOOK_MARKER
  ].join(' ');
}

export function museHookCommand(scriptPath: string, event: string): string {
  if (process.platform === 'win32') {
    return museHookCommandWindows(scriptPath, event);
  }

  return [
    shellQuoteArg(process.execPath),
    shellQuoteArg(scriptPath),
    'muse-hook',
    '--event',
    shellQuoteArg(event),
    MUSE_MANAGED_HOOK_MARKER
  ].join(' ');
}

export function isManagedMuseHook(hook: unknown): boolean {
  const record = asRecord(hook);
  const command = typeof record?.command === 'string' ? record.command : '';
  return record?.type === 'command' && command.includes(MUSE_MANAGED_HOOK_MARKER);
}

export interface ManagedMuseHookMutation {
  settings: JsonRecord;
  installed: number;
  removed: number;
}

export interface ManagedMuseHookRemoval {
  settings: JsonRecord;
  removed: number;
}

export interface ManagedMuseHookStatus {
  installed: boolean;
  managedCount: number;
  eventCounts: Record<string, number>;
  missingEvents: string[];
  duplicateEvents: string[];
  unexpectedEvents: string[];
}

export function removeManagedMuseHooks(settings: unknown): ManagedMuseHookRemoval {
  const source = asRecord(settings) ?? {};
  const nextSettings: JsonRecord = { ...source };
  const sourceHooks = asRecord(source.hooks);
  if (!sourceHooks) {
    return { settings: nextSettings, removed: 0 };
  }

  const nextHooks: JsonRecord = { ...sourceHooks };
  let removed = 0;

  for (const [eventName, groupsValue] of Object.entries(sourceHooks)) {
    if (!Array.isArray(groupsValue)) {
      continue;
    }

    const nextGroups: unknown[] = [];
    for (const groupValue of groupsValue) {
      const group = asRecord(groupValue);
      const hookList = Array.isArray(group?.hooks) ? group.hooks : null;
      if (!group || !hookList) {
        nextGroups.push(groupValue);
        continue;
      }

      const nextHookList = hookList.filter((hook) => {
        const owned = isManagedMuseHook(hook);
        if (owned) {
          removed += 1;
        }
        return !owned;
      });

      if (nextHookList.length > 0 || nextHookList.length === hookList.length) {
        nextGroups.push(nextHookList.length === hookList.length
          ? groupValue
          : { ...group, hooks: nextHookList });
      }
    }

    if (nextGroups.length > 0 || groupsValue.length === 0) {
      nextHooks[eventName] = nextGroups;
    } else {
      delete nextHooks[eventName];
    }
  }

  nextSettings.hooks = nextHooks;
  return { settings: nextSettings, removed };
}

export function installManagedMuseHooks(
  settings: unknown,
  scriptPath: string,
  events: readonly string[] = MUSE_HOOK_EVENTS
): ManagedMuseHookMutation {
  const names = uniqueEvents(events);
  const cleaned = removeManagedMuseHooks(settings);
  const nextSettings: JsonRecord = { ...cleaned.settings };
  const hooks = { ...(asRecord(cleaned.settings.hooks) ?? {}) };
  let installed = 0;

  for (const eventName of names) {
    const command = museHookCommand(scriptPath, eventName);
    const commandWindows = museHookCommandWindows(scriptPath, eventName);
    if (!command.includes(MUSE_MANAGED_HOOK_MARKER) || !commandWindows.includes(MUSE_MANAGED_HOOK_MARKER)) {
      throw new Error(`Managed Muse hook command for ${eventName} must include ${MUSE_MANAGED_HOOK_MARKER}`);
    }

    const groups = Array.isArray(hooks[eventName]) ? [...hooks[eventName] as unknown[]] : [];
    groups.push({
      hooks: [
        {
          type: 'command',
          command,
          commandWindows,
          timeout: MUSE_HOOK_TIMEOUT_SECONDS,
          async: false
        }
      ]
    });
    hooks[eventName] = groups;
    installed += 1;
  }

  nextSettings.hooks = hooks;
  // Documented standalone schema carries schema_version 1. An existing value
  // (whatever the user has) is preserved; only a missing one is added.
  if (nextSettings.schema_version === undefined) {
    nextSettings.schema_version = MUSE_SETTINGS_SCHEMA_VERSION;
  }

  return {
    settings: nextSettings,
    installed,
    removed: cleaned.removed
  };
}

export function getManagedMuseHookStatus(
  settings: unknown,
  expectedEvents: readonly string[] = MUSE_HOOK_EVENTS
): ManagedMuseHookStatus {
  const hooks = asRecord(asRecord(settings)?.hooks) ?? {};
  const eventCounts: Record<string, number> = {};
  let managedCount = 0;

  for (const [eventName, groupsValue] of Object.entries(hooks)) {
    if (!Array.isArray(groupsValue)) {
      continue;
    }

    for (const groupValue of groupsValue) {
      const group = asRecord(groupValue);
      const hookList = Array.isArray(group?.hooks) ? group.hooks : [];
      const count = hookList.filter(isManagedMuseHook).length;
      if (count > 0) {
        eventCounts[eventName] = (eventCounts[eventName] ?? 0) + count;
        managedCount += count;
      }
    }
  }

  const expected = uniqueEvents(expectedEvents);
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

export function readMuseSettings(): JsonRecord {
  if (!fs.existsSync(MUSE_SETTINGS_FILE)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(MUSE_SETTINGS_FILE, 'utf8')) as unknown;
    return asRecord(parsed) || {};
  } catch (_) {
    // A corrupt settings file must never crash status/setup; install backs it
    // up as .bak before replacing it.
    return {};
  }
}

/**
 * Writes settings through a temp file + rename (UTF-8, no BOM) so a crash
 * mid-write cannot leave Muse with a truncated settings.json, keeping a
 * `.bak` of the previous file.
 */
export function writeMuseSettings(settingsFile: string, settings: JsonRecord): void {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });

  if (fs.existsSync(settingsFile)) {
    fs.copyFileSync(settingsFile, `${settingsFile}.bak`);
  }

  const tempFile = `${settingsFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempFile, settingsFile);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch (_) {
      // The successful rename already removed the temporary pathname.
    }
  }
}

export interface MuseAncestorEntry {
  pid: number;
  ppid: number;
  name: string;
  exe: string | null;
  created: string;
}

function windowsPowerShellPath(): string {
  const root = (process.env.SystemRoot || 'C:\\Windows').trim() || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function asAncestorEntry(row: unknown): MuseAncestorEntry | null {
  const record = asRecord(row);
  if (!record) {
    return null;
  }
  const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : null;
  const ppid = typeof record.ppid === 'number' && Number.isInteger(record.ppid) ? record.ppid : null;
  const name = typeof record.name === 'string' ? record.name : '';
  const exe = typeof record.exe === 'string' ? record.exe : null;
  const created = typeof record.created === 'string' ? record.created : '';
  if (pid === null || ppid === null || !name.trim() || !created.trim()) {
    return null;
  }
  return { pid, ppid, name, exe, created };
}

// Query-only CIM walk from the receiver's parent: ProcessId/
// ParentProcessId/Name/ExecutablePath/CreationDate only, one bounded
// PowerShell spawn, cycle-guarded. Never CommandLine (may carry prompts).
function queryMuseAncestorChain(ppid: number): MuseAncestorEntry[] | null {
  if (process.platform !== 'win32' || process.env.DISCORD_CODING_STATUS_PROCESS_DETECTION === 'off') {
    return null;
  }
  if (!Number.isInteger(ppid) || ppid <= 0) {
    return null;
  }

  const script = [
    '$musePp=' + String(ppid) + ';',
    '$museChain=@();$museSeen=@{};',
    'while($musePp -gt 0 -and $museChain.Count -lt ' + MUSE_BINDER_DEPTH + ' -and -not $museSeen.ContainsKey($musePp)){',
    '$museSeen[$musePp]=1;',
    'try { $museQ=Get-CimInstance Win32_Process -Filter (\'ProcessId=\' + $musePp) -ErrorAction Stop } catch { break };',
    'if(-not $museQ){ break };',
    '$museChain+=@([pscustomobject]@{pid=$museQ.ProcessId;ppid=$museQ.ParentProcessId;name=$museQ.Name;exe=$museQ.ExecutablePath;created=$museQ.CreationDate.ToString(\'o\')});',
    'if($museQ.Name -match \'^muse\'){ break };',
    '$musePp=$museQ.ParentProcessId };',
    'ConvertTo-Json -InputObject $museChain -Compress -Depth 3'
  ].join('');

  try {
    const out = execFileSync(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: MUSE_BINDER_TIMEOUT_MS,
      maxBuffer: 65536,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString('utf8').trim();
    if (!out) {
      return [];
    }
    const parsed: unknown = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map(asAncestorEntry)
      .filter((entry): entry is MuseAncestorEntry => Boolean(entry));
  } catch (_) {
    return null;
  }
}

export interface MuseBindingProof {
  musePid: number;
  museCreatedAtMs: number;
}

/**
 * Resolves the owning Muse process from a parent-first ancestor chain.
 * Stops at the FIRST positively verified Muse binary. Creation order is
 * enforced (a parent newer than its child is PID reuse — the invalid tail is
 * truncated, never trusted), cycles terminate the walk, and anything
 * ambiguous yields null. Wrappers (cmd/pwsh) are stepped through, never
 * mistaken for the owner.
 */
export function resolveOwningMuseFromChain(
  chain: readonly MuseAncestorEntry[] | null | undefined,
  nowMs: number = Date.now()
): MuseBindingProof | null {
  if (!Array.isArray(chain) || chain.length === 0) {
    return null;
  }

  const seen = new Set<number>();
  let childCreatedAtMs = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();

  for (const entry of chain.slice(0, MUSE_BINDER_DEPTH)) {
    const pid = entry?.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || seen.has(pid)) {
      break;
    }
    seen.add(pid);

    const createdAtMs = Date.parse(typeof entry.created === 'string' ? entry.created : '');
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
      break;
    }
    if (createdAtMs > childCreatedAtMs) {
      break;
    }
    childCreatedAtMs = createdAtMs;

    const identity = typeof entry.exe === 'string' && entry.exe.trim()
      ? entry.exe
      : (typeof entry.name === 'string' ? entry.name : '');
    const normalized = identity.replace(/\\/g, '/');
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (basename && isMuseBinaryBasename(basename)) {
      return { musePid: pid, museCreatedAtMs: createdAtMs };
    }
  }

  return null;
}

export interface FindOwningMuseOptions {
  ppid?: number;
  nowMs?: number;
  queryChain?: (ppid: number) => readonly MuseAncestorEntry[] | null;
}

export function findOwningMuseProcess(options: FindOwningMuseOptions = {}): MuseBindingProof | null {
  try {
    if (process.platform !== 'win32' && !options.queryChain) {
      return null;
    }
    const ppid = options.ppid ?? process.ppid;
    if (!Number.isInteger(ppid) || ppid <= 0) {
      return null;
    }
    const query = options.queryChain ?? queryMuseAncestorChain;
    return resolveOwningMuseFromChain(query(ppid), options.nowMs ?? Date.now());
  } catch (_) {
    return null;
  }
}

function topLevelString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * The documented stdin `model` is the model in use (authoritative UI name,
 * shown as-is). Only proven non-models are rejected: the offline echo
 * placeholder `unknown` and the `same-as-main` routing alias.
 */
export function normalizeMuseHookModel(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const model = value.trim().replace(/\s+/g, ' ');
  if (!model || model.toLowerCase() === 'unknown' || model === 'same-as-main') {
    return null;
  }
  return model;
}

export function statusFromMuseHookEvent(event: string): string {
  const normalized = event.trim().toLowerCase().replace(/_/g, '');

  if (normalized === 'sessionend') {
    return 'stopped';
  }

  if (
    normalized === 'sessionstart'
    || normalized === 'userpromptsubmit'
    || normalized === 'prellmcall'
    || normalized === 'postllmcall'
  ) {
    return 'running';
  }

  return 'active';
}

// The Muse hook process is a passive reporter: it must ALWAYS exit 0 and
// never write to stdout, so lifecycle hooks cannot block the agent. Only
// top-level event/session/model keys are consumed; prompts, tool data, and
// transcript content are never read, and no cwd/model/effort is guessed.
export function museHookSessionFromArgs(args: Record<string, string | boolean>): HookSessionState {
  const input = readHookInput();
  const event = getArgString(args, 'event')
    || topLevelString(input, ['hook_event_name'])
    || 'unknown';
  const cwd = path.resolve(getArgString(args, 'cwd') || process.cwd());
  const sessionId = getArgString(args, 'session-id')
    || getArgString(args, 'session_id')
    || topLevelString(input, ['session_id', 'sessionId'])
    || `muse:cli:${cwd}:${process.ppid}`;
  const model = getArgString(args, 'model')
    || normalizeMuseHookModel(topLevelString(input, ['model']))
    || undefined;
  const status = statusFromMuseHookEvent(event);
  const now = Date.now();
  const existing = status !== 'stopped'
    ? readStateFile().sessions[sessionId] as MuseHookSessionState | undefined
    : undefined;
  const retained = (existing
    && typeof existing.musePid === 'number'
    && existing.musePid > 0
    && typeof existing.museCreatedAtMs === 'number'
    && existing.museCreatedAtMs > 0
    && isProcessAlive(existing.musePid))
    ? { musePid: existing.musePid, museCreatedAtMs: existing.museCreatedAtMs }
    : null;
  // A failed CIM walk is remembered per session so the synchronous
  // PreLLMCall/PostLLMCall hooks do not re-spawn powershell.exe (up to
  // MUSE_BINDER_TIMEOUT_MS each) on every LLM call. Retry on human-paced
  // events, or once the negative result is older than the retry window.
  const lastAttempt = typeof existing?.museBindAttemptedAt === 'number' ? existing.museBindAttemptedAt : 0;
  const skipWalk = !retained
    && !isMuseBindRetryEvent(event)
    && lastAttempt > 0
    && lastAttempt <= now
    && now - lastAttempt < MUSE_BIND_RETRY_MS;
  let bindAttemptedAt: number | null = null;
  let binding: MuseBindingProof | null = null;
  if (status !== 'stopped') {
    if (retained) {
      binding = retained;
    } else if (!skipWalk) {
      binding = findOwningMuseProcess();
      if (!binding) {
        bindAttemptedAt = now;
      }
    }
  }

  const session: MuseHookSessionState = {
    tool: 'muse',
    surface: getArgString(args, 'surface') || 'cli',
    status: statusFromMuseHookEvent(event),
    session_id: sessionId,
    cwd,
    updated_at: now,
    model
  };
  if (binding) {
    session.musePid = binding.musePid;
    session.museCreatedAtMs = binding.museCreatedAtMs;
    // Explicit undefined clears a stale negative result through the upsert spread.
    session.museBindAttemptedAt = undefined;
  }
  if (bindAttemptedAt !== null) {
    session.museBindAttemptedAt = bindAttemptedAt;
  }
  return session;
}
