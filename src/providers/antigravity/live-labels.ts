'use strict';

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

// Antigravity's picker list comes from its own language server
// (language_server.exe), which answers GetCascadeModelConfigData on a local
// HTTP port with every entry it shows: { label: "Gemini 3.8 Flash (Medium)",
// modelOrAlias: { model: "MODEL_PLACEHOLDER_M319" } }. That list is the app's
// own, so a model Google adds later resolves here with no update. The port is
// read from the server's log; the token is sent only after Windows confirms
// that the logged pid is Antigravity's language_server.exe AND owns that
// listening port. The CSRF token comes from its command line. The last good
// list is kept on disk, so hook processes and a restarted daemon read it
// without asking the server again.

const LS_SERVICE_PATH = '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData';
const LS_LOG_CHUNK_BYTES = 256 * 1024;
const LS_START_MARK = 'Starting language server process with pid ';
const LS_START_BLOCK_BYTES = 256 * 1024;
const LS_REQUEST_TIMEOUT_MS = 2_500;
const LS_RESPONSE_MAX_BYTES = 1024 * 1024;
const LS_LOOKUP_TIMEOUT_MS = 5_000;
const REFRESH_KNOWN_MS = 30 * 60_000;
const RETRY_UNKNOWN_MS = 30_000;
const RENAME_RETRY_DELAYS_MS = [25, 75, 200];
const PLACEHOLDER = /^MODEL_[A-Z0-9_]{1,64}$/;
const LABEL = /^[^\r\n"\\]{1,80}$/;

export interface LanguageServerEndpoint {
  pid: number;
  httpPort: number;
}

export function getAntigravityUserDataDir(): string {
  const override = String(process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_USER_DATA || '').trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Antigravity');
}

export function getAntigravityLabelCacheFile(): string {
  const override = String(process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_LABEL_CACHE || '').trim();
  if (override) {
    return path.resolve(override);
  }
  const base = process.env.DISCORD_CODING_STATUS_HELPER_CACHE_DIR
    || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'discord-coding-status', 'cache');
  return path.join(base, 'antigravity-models.json');
}

// "Starting language server process with pid 49612" and "Language server
// listening on random port at 51447 for HTTP"; the HTTPS (gRPC) port is skipped.
export function parseLanguageServerLog(text: string): LanguageServerEndpoint | null {
  let pid = 0;
  let httpPort = 0;
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/Starting language server process with pid (\d+)/);
    if (start) {
      pid = Number(start[1]);
      httpPort = 0;
      continue;
    }
    const port = line.match(/listening on random port at (\d+) for HTTP(?!S)/);
    if (port) {
      httpPort = Number(port[1]);
    }
  }
  return pid > 0 && httpPort > 0 && httpPort < 65536 ? { pid, httpPort } : null;
}

export function parseCascadeModelConfigs(json: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  const configs = (json as { clientModelConfigs?: unknown })?.clientModelConfigs;
  if (!Array.isArray(configs)) {
    return labels;
  }
  for (const config of configs) {
    const placeholder = config?.modelOrAlias?.model;
    const label = typeof config?.label === 'string' ? config.label.trim() : '';
    if (typeof placeholder === 'string' && PLACEHOLDER.test(placeholder) && LABEL.test(label)) {
      labels.set(placeholder, label);
    }
  }
  return labels;
}

// --- persisted list ----------------------------------------------------------

interface LabelList {
  labels: Map<string, string>;
  fetchedAt: number;
}

let diskCache: (LabelList & { filePath: string; mtimeMs: number }) | null = null;
// The daemon's own last fetch, kept even when writing it to disk failed.
let memoryList: (LabelList & { filePath: string }) | null = null;
let persistPending = false;

function readPersistedLabels(): LabelList {
  const filePath = getAntigravityLabelCacheFile();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch (_) {
    diskCache = null;
    return { labels: new Map(), fetchedAt: 0 };
  }
  if (diskCache && diskCache.filePath === filePath && diskCache.mtimeMs === mtimeMs) {
    return diskCache;
  }
  const labels = new Map<string, string>();
  let fetchedAt = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { fetchedAt?: unknown; labels?: Record<string, unknown> };
    fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
    for (const [placeholder, label] of Object.entries(parsed.labels || {})) {
      if (PLACEHOLDER.test(placeholder) && typeof label === 'string' && LABEL.test(label)) {
        labels.set(placeholder, label);
      }
    }
  } catch (_) {
    // Torn or foreign file: treat as empty; the next fetch rewrites it.
  }
  diskCache = { filePath, mtimeMs, labels, fetchedAt };
  return diskCache;
}

function readLabelList(): LabelList {
  const disk = readPersistedLabels();
  if (memoryList && memoryList.filePath === getAntigravityLabelCacheFile() && memoryList.fetchedAt > disk.fetchedAt) {
    return memoryList;
  }
  return disk;
}

// Atomic replace; scanners briefly lock the destination on Windows, so
// EPERM/EACCES/EBUSY renames are retried before giving up. Returns false when
// the list could not be written (the in-memory copy still serves the daemon).
// A refresh overtaken by a reset stops before it replaces the file: the
// generation check and the rename run in the same synchronous step.
let tmpSequence = 0;

async function writePersistedLabels(list: LabelList, isCurrent: () => boolean): Promise<boolean> {
  const filePath = getAntigravityLabelCacheFile();
  tmpSequence += 1;
  const tmp = `${filePath}.${process.pid}.${tmpSequence}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify({ fetchedAt: list.fetchedAt, labels: Object.fromEntries(list.labels) }, null, 2), 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      if (!isCurrent()) {
        throw new Error('refresh superseded');
      }
      try {
        fs.renameSync(tmp, filePath);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const delay = RENAME_RETRY_DELAYS_MS[attempt];
        if ((code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || delay === undefined) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } catch (_) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    return false;
  } finally {
    diskCache = null;
  }
}

export function readAntigravityLiveLabel(placeholder: string | null): string | null {
  if (!placeholder) {
    return null;
  }
  return readLabelList().labels.get(placeholder) || null;
}

// --- fetching from the running language server -------------------------------

export function fetchAntigravityModelLabels(endpoint: { httpPort: number; csrfToken: string }): Promise<Map<string, string>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const body = '{}';
    // `timeout` below only measures socket idleness; a trickling answer would
    // hold the refresh open, so the whole exchange also has a hard deadline.
    const deadline = setTimeout(() => request.destroy(new Error('language server deadline passed')), LS_REQUEST_TIMEOUT_MS);
    const resolve = (labels: Map<string, string>) => {
      clearTimeout(deadline);
      resolvePromise(labels);
    };
    const reject = (error: unknown) => {
      clearTimeout(deadline);
      rejectPromise(error);
    };
    const request = http.request({
      host: '127.0.0.1',
      port: endpoint.httpPort,
      method: 'POST',
      path: LS_SERVICE_PATH,
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': endpoint.csrfToken,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: LS_REQUEST_TIMEOUT_MS
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > LS_RESPONSE_MAX_BYTES) {
          request.destroy(new Error('language server response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`language server answered ${response.statusCode}`));
          return;
        }
        try {
          resolve(parseCascadeModelConfigs(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('language server timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

// The server truncates its log on each start, but an appended log is searched
// backwards in chunks for the newest start line, so its block wins wherever it
// sits. Only that line and the window after it (where the port lines follow)
// are kept, so memory stays bounded on a large log. latin1 keeps byte offsets
// and characters 1:1 across chunk joins.
export function readLanguageServerEndpoint(): LanguageServerEndpoint | null {
  const logFile = path.join(getAntigravityUserDataDir(), 'logs', 'language_server.log');
  try {
    const fd = fs.openSync(logFile, 'r');
    try {
      let position = fs.fstatSync(fd).size;
      let text = '';
      while (position > 0) {
        const length = Math.min(LS_LOG_CHUNK_BYTES, position);
        position -= length;
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(fd, buffer, 0, length, position);
        text = buffer.subarray(0, read).toString('latin1') + text;
        const start = text.lastIndexOf(LS_START_MARK);
        if (start >= 0) {
          return parseLanguageServerLog(text.slice(start, start + LS_START_BLOCK_BYTES));
        }
        // No start line yet: keep the window a start found in the next
        // (earlier) chunk would need, including its port lines.
        text = text.slice(0, LS_START_BLOCK_BYTES);
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return null;
  }
}

// `lookup` is { Process: Win32_Process fields, PortOwners: pids listening on
// 127.0.0.1:<httpPort> }. The token is returned only when that pid is
// Antigravity's language server and the port is its own.
export function parseLanguageServerLookup(lookup: unknown, endpoint: LanguageServerEndpoint): string | null {
  const { Process: record, PortOwners: owners } = (lookup || {}) as { Process?: unknown; PortOwners?: unknown };
  const portOwners = (Array.isArray(owners) ? owners : [owners]).map(Number);
  if (portOwners.length === 0 || !portOwners.every((owner) => owner === endpoint.pid)) {
    return null;
  }
  const info = record as { Name?: unknown; ProcessId?: unknown; ExecutablePath?: unknown; CommandLine?: unknown } | null;
  if (!info || Number(info.ProcessId) !== endpoint.pid || String(info.Name || '').toLowerCase() !== 'language_server.exe') {
    return null;
  }
  if (!/[\\/]antigravity[\\/]/i.test(String(info.ExecutablePath || ''))) {
    return null;
  }
  const token = String(info.CommandLine || '').match(/--csrf_token[ =]([A-Za-z0-9_-]{8,128})(?:\s|$)/);
  return token?.[1] || null;
}

// The token sits only on the server's command line; it is read for this one
// request and never stored or logged.
function readLanguageServerCsrfToken(endpoint: LanguageServerEndpoint): Promise<string | null> {
  if (process.platform !== 'win32') {
    return Promise.resolve(null);
  }
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${endpoint.pid}" | Select-Object Name,ProcessId,ExecutablePath,CommandLine;`,
    `$o = @(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort ${endpoint.httpPort} -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess });`,
    '[pscustomobject]@{ Process = $p; PortOwners = $o } | ConvertTo-Json -Compress -Depth 3'
  ].join(' ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: LS_LOOKUP_TIMEOUT_MS }, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          resolve(parseLanguageServerLookup(JSON.parse(String(stdout || '').trim() || 'null'), endpoint));
        } catch (_) {
          resolve(null);
        }
      });
  });
}

let refreshInFlight: Promise<void> | null = null;
let lastAttemptAt = 0;
let generation = 0;
let changeListener: (() => void) | null = null;

export function onAntigravityLiveLabelsChanged(listener: (() => void) | null): void {
  changeListener = listener;
}

export function resetAntigravityLiveLabelsForTests(): void {
  // A refresh still running from before the reset sees a newer generation and
  // drops its result instead of writing into the next test's cache.
  generation += 1;
  diskCache = null;
  memoryList = null;
  persistPending = false;
  refreshInFlight = null;
  lastAttemptAt = 0;
  changeListener = null;
}

function runRefresh(work: (isCurrent: () => boolean) => Promise<void>): void {
  const mine = generation;
  const isCurrent = () => mine === generation;
  const run = work(isCurrent)
    .catch(() => {
      // Server starting, restarting or unreachable: keep the stored list.
    })
    .finally(() => {
      if (isCurrent() && refreshInFlight === run) {
        refreshInFlight = null;
      }
    });
  refreshInFlight = run;
}

// Called whenever the daemon renders an Antigravity selection. A placeholder
// the stored list already names is refreshed at most every 30 minutes; one it
// does not name is retried at most every 30 seconds, so a brand-new model is
// picked up within one retry of the server knowing it. A list fetched but not
// yet written to disk is re-written on the same 30-second cadence.
export function ensureAntigravityLiveLabels(placeholder: string | null): void {
  if (!placeholder || refreshInFlight) {
    return;
  }
  const now = Date.now();
  const current = readLabelList();
  const known = current.labels.has(placeholder);
  const fresh = known && now - current.fetchedAt < REFRESH_KNOWN_MS;
  if (fresh && !persistPending) {
    return;
  }
  const interval = !known || persistPending ? RETRY_UNKNOWN_MS : REFRESH_KNOWN_MS;
  if (now - lastAttemptAt < interval) {
    return;
  }
  lastAttemptAt = now;

  runRefresh(async (isCurrent) => {
    // An unwritten list is retried whether or not a fetch follows, so it
    // reaches the hook processes even while the server is unreachable.
    if (persistPending && memoryList) {
      const written = await writePersistedLabels(memoryList, isCurrent);
      if (!isCurrent()) {
        return;
      }
      persistPending = !written;
    }
    if (fresh) {
      return;
    }
    const endpoint = readLanguageServerEndpoint();
    if (!endpoint) {
      return;
    }
    const csrfToken = await readLanguageServerCsrfToken(endpoint);
    if (!csrfToken || !isCurrent()) {
      return;
    }
    const labels = await fetchAntigravityModelLabels({ httpPort: endpoint.httpPort, csrfToken });
    if (labels.size === 0 || !isCurrent()) {
      return;
    }
    const changed = labels.size !== current.labels.size
      || [...labels].some(([key, value]) => current.labels.get(key) !== value);
    const list = { labels, fetchedAt: Date.now() };
    memoryList = { ...list, filePath: getAntigravityLabelCacheFile() };
    const written = await writePersistedLabels(list, isCurrent);
    if (!isCurrent()) {
      return;
    }
    persistPending = !written;
    if (changed) {
      changeListener?.();
    }
  });
}
