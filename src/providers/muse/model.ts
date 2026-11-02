'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProcessInfo } from '../../core/tools/types';

/**
 * Bound Muse model parser: single explicit file only (global scan disabled).
 *
 * Muse keeps JSONL session logs at
 * `${XDG_DATA_HOME:-~/.local/share}/muse/sessions/YYYY/MM/DD/<id>/session.jsonl`.
 * Each model switch appends a `run.model.configured` record carrying
 * `payload.record.model_id`. This reader extracts only that whitelisted
 * metadata field: prompts, tool calls, and transcript content are parsed but
 * never copied, logged, or returned.
 */

const MODEL_EVENT = 'run.model.configured';
const MAX_TAIL_BYTES = 256 * 1024;

export function museSessionsRoot(): string {
  const xdg = (process.env.XDG_DATA_HOME || '').trim();
  const base = xdg ? xdg : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'muse', 'sessions');
}

function extractModelId(record: unknown): string | null {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const payload = (record as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const data = payload as {
    record?: { model_id?: unknown };
    event?: { model?: unknown };
  };
  const modelId = data.record?.model_id ?? data.event?.model;
  if (typeof modelId !== 'string') {
    return null;
  }

  const model = modelId.trim();
  // 'same-as-main' is a routing alias, not a real model id. Never display it.
  return model && model !== 'same-as-main' ? model : null;
}

function isModelRecord(record: unknown): boolean {
  if (!record || typeof record !== 'object') {
    return false;
  }

  return (record as { payload_type?: unknown }).payload_type === MODEL_EVENT;
}

function readTailLines(file: string): string[] {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, MAX_TAIL_BYTES);
  if (length <= 0) {
    return [];
  }

  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    let text = buffer.toString('utf8');
    if (stat.size > length) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    return text.split('\n');
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_) {
      // Best effort cleanup for a local session read.
    }
  }
}

export function readMuseModelFromFile(file: string): string | null {
  let lines: string[];
  try {
    lines = readTailLines(file);
  } catch (_) {
    return null;
  }

  let fallback: string | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }

    const model = extractModelId(record);
    if (!model) {
      continue;
    }

    // The explicit model-configured event is authoritative; a model id on any
    // other record is only a fallback for older session formats.
    if (isModelRecord(record)) {
      return model;
    }

    fallback = fallback || model;
  }

  return fallback;
}

export interface MuseModelResult {
  model: string;
  sessionFile: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MUSE_EXE_RE = /^muse(\.exe)?$/i;
const MUSE_BIN_RE = /^muse-bin-[\w.+-]+(\.exe)?$/i;
const SESSION_END_EVENT = 'session.end';
const ROUTE_FACTS_EVENT = 'runtime.session.route_facts';
const MAX_HEAD_BYTES = 64 * 1024;

function basenameOf(value: string): string {
  return path.posix.basename(value.replace(/\\/g, '/'));
}

function isMuseExecutableName(name: string): boolean {
  return MUSE_EXE_RE.test(name) || MUSE_BIN_RE.test(name);
}

export function splitMuseCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < commandLine.length; index += 1) {
    const ch = commandLine[index];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function isAmbiguousSessionFlag(token: string): boolean {
  const lower = token.toLowerCase();
  return lower === '--resume'
    || lower.startsWith('--resume=')
    || lower.startsWith('--resume-')
    || lower === '--continue'
    || lower.startsWith('--continue=')
    || lower === '--session'
    || lower.startsWith('--session=')
    || lower === '--session_id'
    || lower.startsWith('--session_id=')
    || lower === '--sessionid'
    || lower.startsWith('--sessionid=');
}

export function extractMuseExecSessionId(process: ProcessInfo | string): string | null {
  const commandLine = typeof process === 'string'
    ? process
    : (process.commandLine || process.line || '');
  if (!commandLine.trim()) {
    return null;
  }
  if (typeof process !== 'string' && process.executablePath) {
    if (!isMuseExecutableName(basenameOf(process.executablePath))) {
      return null;
    }
  }
  const tokens = splitMuseCommandLine(commandLine);
  if (!tokens.length || !isMuseExecutableName(basenameOf(tokens[0]))) {
    return null;
  }
  if (tokens.length < 2 || tokens[1] !== 'exec') {
    return null;
  }
  const found: string[] = [];
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      break;
    }
    if (token === '--session-id') {
      const value = tokens[index + 1];
      if (!value || value.startsWith('-')) {
        return null;
      }
      found.push(value);
      index += 1;
      continue;
    }
    if (token.toLowerCase().startsWith('--session-id=')) {
      found.push(token.slice('--session-id='.length));
      continue;
    }
    if (isAmbiguousSessionFlag(token)) {
      return null;
    }
  }
  if (found.length !== 1) {
    return null;
  }
  const value = found[0].trim();
  if (!UUID_RE.test(value) || value.includes('/') || value.includes('\\')) {
    return null;
  }
  return value.toLowerCase();
}

// Walk cache for findMuseExecSessionFiles, keyed by sessions root + session id.
// The resolver runs on every fast presence pass (twice), so a full
// year/month/day walk each time is wasteful. Muse creates a session directory
// under the CURRENT date, so between full rescans only day directories at or
// after the newest one seen need re-checking (walked newest-first, stopping at
// the first older day). Cached matches are re-stat'ed so deletions drop out,
// and a full rescan runs at least every MUSE_EXEC_FULL_RESCAN_MS.
const MUSE_EXEC_FULL_RESCAN_MS = 30_000;
const MUSE_EXEC_CACHE_LIMIT = 64;

interface MuseExecListingCacheEntry {
  files: string[];
  newestDayKey: string | null;
  fullScanAt: number;
}

const museExecListingCache = new Map<string, MuseExecListingCacheEntry>();

function setBounded<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MUSE_EXEC_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

function readSortedDesc(dir: string, pattern: RegExp): string[] | null {
  try {
    return fs.readdirSync(dir).filter((name) => pattern.test(name)).sort().reverse();
  } catch (_) {
    return null;
  }
}

/**
 * Newest-first walk of `<root>/YYYY/MM/DD/<uuid>/session.jsonl`. With
 * `minDayKey` ("YYYY/MM/DD"), days older than it are not visited. Returns
 * null when the root itself cannot be read.
 */
function scanMuseExecSessionDays(
  root: string,
  normalized: string,
  minDayKey: string | null
): { files: string[]; newestDayKey: string | null } | null {
  const years = readSortedDesc(root, /^\d{4}$/);
  if (!years) {
    return null;
  }
  const files: string[] = [];
  let newestDayKey: string | null = null;
  for (const year of years) {
    if (minDayKey && year < minDayKey.slice(0, 4)) {
      break;
    }
    const months = readSortedDesc(path.join(root, year), /^\d{2}$/) ?? [];
    for (const month of months) {
      if (minDayKey && `${year}/${month}` < minDayKey.slice(0, 7)) {
        break;
      }
      const days = readSortedDesc(path.join(root, year, month), /^\d{2}$/) ?? [];
      for (const day of days) {
        const dayKey = `${year}/${month}/${day}`;
        if (minDayKey && dayKey < minDayKey) {
          break;
        }
        if (newestDayKey === null || dayKey > newestDayKey) {
          newestDayKey = dayKey;
        }
        const file = path.join(root, year, month, day, normalized, 'session.jsonl');
        try {
          if (fs.statSync(file).isFile()) {
            files.push(file);
          }
        } catch (_) {
          // Missing UUID directory under this date; keep looking.
        }
      }
    }
  }
  return { files, newestDayKey };
}

function isExistingFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

export function findMuseExecSessionFiles(sessionId: string): string[] {
  if (!UUID_RE.test(sessionId)) {
    return [];
  }
  const normalized = sessionId.toLowerCase();
  const root = museSessionsRoot();
  const key = `${root}|${normalized}`;
  const now = Date.now();
  const cached = museExecListingCache.get(key);
  const incremental = Boolean(
    cached && now >= cached.fullScanAt && now - cached.fullScanAt < MUSE_EXEC_FULL_RESCAN_MS
  );

  const scan = scanMuseExecSessionDays(root, normalized, incremental && cached ? cached.newestDayKey : null);
  if (!scan) {
    museExecListingCache.delete(key);
    return [];
  }

  let files = scan.files;
  let newestDayKey = scan.newestDayKey;
  let fullScanAt = now;
  if (incremental && cached) {
    const seen = new Set(files);
    const survivors = cached.files.filter((file) => !seen.has(file) && isExistingFile(file));
    files = [...files, ...survivors].sort().reverse();
    if (cached.newestDayKey && (!newestDayKey || cached.newestDayKey > newestDayKey)) {
      newestDayKey = cached.newestDayKey;
    }
    fullScanAt = cached.fullScanAt;
  }

  setBounded(museExecListingCache, key, { files, newestDayKey, fullScanAt });
  return [...files];
}

function readHeadLines(file: string): string[] {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(file);
    const length = Math.min(stat.size, MAX_HEAD_BYTES);
    if (length <= 0) {
      return [];
    }
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    let text = buffer.toString('utf8');
    if (stat.size > length) {
      const lastNewline = text.lastIndexOf('\n');
      text = lastNewline === -1 ? '' : text.slice(0, lastNewline);
    }
    return text.split('\n');
  } catch (_) {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        // Best effort cleanup for a local session read.
      }
    }
  }
}

function parseRecordedAtMs(record: unknown): number | null {
  const at = (record as { recorded_at?: unknown })?.recorded_at;
  const num = typeof at === 'number' ? at : Number(at);
  if (!Number.isFinite(num) || num < 1e15 || num > 3e15) {
    return null;
  }
  return Math.floor(num / 1000);
}

function recordStreamId(record: unknown): string | null {
  const stream = (record as { stream?: unknown })?.stream;
  const id = (stream as { id?: unknown })?.id;
  return typeof id === 'string' && id.trim() ? id.trim().toLowerCase() : null;
}

function routeFactsPid(record: unknown): number | null {
  if ((record as { payload_type?: unknown })?.payload_type !== ROUTE_FACTS_EVENT) {
    return null;
  }
  const payload = (record as { payload?: unknown })?.payload;
  const rec = (payload as { record?: unknown })?.record;
  const pid = (rec as { pid?: unknown })?.pid;
  return typeof pid === 'number' && Number.isFinite(pid) && Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isSessionEnd(record: unknown): boolean {
  return (record as { payload_type?: unknown })?.payload_type === SESSION_END_EVENT;
}

function parseJsonLines(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed));
    } catch (_) {
      // Ignore incomplete or non-JSON session lines.
    }
  }
  return out;
}

function readGuardedExecModel(file: string, sessionId: string, pid: number, createdAtMs: number): string | null {
  if (!Number.isFinite(pid) || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
    return null;
  }
  let tail: string[];
  try {
    tail = readTailLines(file);
  } catch (_) {
    return null;
  }
  const records = parseJsonLines(tail);
  let model: string | null = null;
  let modelIndex = -1;
  let modelAt: number | null = null;
  let endIndex = -1;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const streamId = recordStreamId(record);
    if (isSessionEnd(record)) {
      if (streamId !== sessionId) {
        continue;
      }
      endIndex = index;
      continue;
    }
    if (!isModelRecord(record)) {
      continue;
    }
    const id = extractModelId(record);
    if (!id || streamId !== sessionId) {
      continue;
    }
    const at = parseRecordedAtMs(record);
    if (at === null || at < createdAtMs) {
      continue;
    }
    model = id;
    modelIndex = index;
    modelAt = at;
  }
  if (!model || modelIndex < 0 || modelAt === null) {
    return null;
  }
  if (endIndex > modelIndex) {
    return null;
  }
  const headRecords = parseJsonLines(readHeadLines(file));
  const combined = headRecords.length ? [...headRecords, ...records] : records;
  let boundPid: number | null = null;
  for (const record of combined) {
    const candidate = routeFactsPid(record);
    if (candidate === null) {
      continue;
    }
    if (recordStreamId(record) !== sessionId) {
      continue;
    }
    const at = parseRecordedAtMs(record);
    if (at === null || at < createdAtMs) {
      continue;
    }
    boundPid = candidate;
  }
  if (boundPid !== pid) {
    return null;
  }
  return model;
}

// Guarded-read cache: the result of readGuardedExecModel is a pure function of
// the file content (identified by path + mtimeMs + size) and the binding
// inputs, so an unchanged file is never re-read (256 KB tail + 64 KB head).
interface MuseExecModelCacheEntry {
  mtimeMs: number;
  size: number;
  sessionId: string;
  pid: number;
  createdAtMs: number;
  model: string | null;
}

const museExecModelCache = new Map<string, MuseExecModelCacheEntry>();

function readGuardedExecModelCached(file: string, sessionId: string, pid: number, createdAtMs: number): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    museExecModelCache.delete(file);
    return null;
  }
  const cached = museExecModelCache.get(file);
  if (
    cached
    && cached.mtimeMs === stat.mtimeMs
    && cached.size === stat.size
    && cached.sessionId === sessionId
    && cached.pid === pid
    && cached.createdAtMs === createdAtMs
  ) {
    return cached.model;
  }
  const model = readGuardedExecModel(file, sessionId, pid, createdAtMs);
  setBounded(museExecModelCache, file, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sessionId,
    pid,
    createdAtMs,
    model
  });
  return model;
}

export function readMuseExecModelForProcess(process: ProcessInfo): MuseModelResult | null {
  const sessionId = extractMuseExecSessionId(process);
  if (!sessionId) {
    return null;
  }
  const pid = (process as { pid?: unknown }).pid;
  const createdAtMs = (process as { createdAtMs?: unknown }).createdAtMs;
  if (typeof pid !== 'number' || !Number.isFinite(pid) || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs) || createdAtMs <= 0) {
    return null;
  }
  const files = findMuseExecSessionFiles(sessionId);
  if (!files.length) {
    return null;
  }
  const passing: MuseModelResult[] = [];
  for (const file of files) {
    const model = readGuardedExecModelCached(file, sessionId, pid, createdAtMs);
    if (model) {
      passing.push({ model, sessionFile: file });
      if (passing.length > 1) {
        // Two passing logs are ambiguous: the result is null regardless of
        // any further files, so stop reading.
        return null;
      }
    }
  }
  return passing.length === 1 ? passing[0] : null;
}

/** Session files have no process binding, so they cannot establish an active model. */
export function readActiveMuseModel(_freshAfterMs: number): MuseModelResult | null {
  return null;
}

export interface MuseSettingsModelResult {
  model: string;
  filePath: string;
  mtimeMs: number;
}

export function getMuseSettingsFilePath(): string {
  const override = String(process.env.DISCORD_CODING_STATUS_MUSE_SETTINGS_FILE || '').trim();
  if (override) {
    return path.resolve(override);
  }

  const xdgConfig = String(process.env.XDG_CONFIG_HOME || '').trim()
    || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'muse', 'settings.json');
}

const museSettingsCache = new Map<string, { mtimeMs: number; model: string | null }>();

export function readMuseSettingsModel(): MuseSettingsModelResult | null {
  const filePath = getMuseSettingsFilePath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    museSettingsCache.delete(filePath);
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }

  const cached = museSettingsCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.model ? { model: cached.model, filePath, mtimeMs: stat.mtimeMs } : null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    museSettingsCache.set(filePath, { mtimeMs: stat.mtimeMs, model: null });
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const raw = typeof record.model === 'string' ? record.model.trim() : '';
  if (!raw || raw.toLowerCase() === 'unknown' || raw.toLowerCase() === 'same-as-main') {
    museSettingsCache.set(filePath, { mtimeMs: stat.mtimeMs, model: null });
    return null;
  }

  museSettingsCache.set(filePath, { mtimeMs: stat.mtimeMs, model: raw });
  return {
    model: raw,
    filePath,
    mtimeMs: stat.mtimeMs
  };
}

