'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergeEffortWithUltracode } from '../../core/presence/effort';

// T3 Code keeps the thread the user is looking at in ~/.t3/userdata/statev2.sqlite
// (orchestration_v2_projection_threads.payload_json modelSelection + lastVisitedAt)
// and a running turn in orchestration_v2_projection_nodes. Model names for every
// provider it has installed live in ~/.t3/caches/<instance>.json `models`.
// The daemon stats those files and re-reads only when one changes. It never
// reads message text.
//
// A model picked in the composer reaches statev2.sqlite only when a message is
// sent (a provider switch is recorded with the turn), and a new thread has no
// row until then. The composer keeps that pick in the renderer's localStorage
// key `t3code:composer-drafts:v1`, written at once to the LevelDB log under
// <userData>/Local Storage/leveldb. Only the model fields are kept from it.

export const T3_VISIBLE_AGENT_MINIMUM = 3;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,120}$/;
const WORKING_STATUSES = ['pending', 'preparing', 'queued', 'starting', 'running'] as const;
const EFFORT_SUFFIX = /\s*\((?:minimal|low|medium|high|xhigh|extra high|max|thinking)\)\s*$/i;

export interface T3WorkingAgent {
  model: string | null;
  instanceId: string | null;
}

export interface T3PresenceSnapshot {
  model: string | null;
  effort?: string | null;
  instanceId: string | null;
  workingAgents: number;
  workingAgentModels?: T3WorkingAgent[];
}

type SqliteModule = { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => any };
let sqliteModule: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule | null {
  if (sqliteModule === undefined) {
    try {
      const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
      sqliteModule = (typeof getBuiltin === 'function' ? getBuiltin.call(process, 'node:sqlite') as SqliteModule : null) || null;
    } catch (_) {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

export function getT3HomeDirectory(): string {
  const configured = (process.env.DISCORD_CODING_STATUS_T3_HOME || process.env.T3CODE_HOME || '').trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), '.t3');
}

export function getT3StateDatabase(): string {
  const override = (process.env.DISCORD_CODING_STATUS_T3_STATE_DB || '').trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(getT3HomeDirectory(), 'userdata', 'statev2.sqlite');
}

export function getT3ModelCacheDirectory(): string {
  return path.join(getT3HomeDirectory(), 'caches');
}

export function getT3ModelManifestFile(): string {
  return path.join(getT3HomeDirectory(), 'userdata', 'model-manifest.json');
}

function fileStamp(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (_) {
    return '';
  }
}

function databaseSignature(filePath: string): string | null {
  const main = fileStamp(filePath);
  if (!main) {
    return null;
  }
  return `${main}|${fileStamp(`${filePath}-wal`)}`;
}

export function cleanT3ModelName(name: string): string | null {
  const text = name.replace(EFFORT_SUFFIX, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 80) {
    return null;
  }
  return text;
}

export function rememberT3ModelName(names: Map<string, string>, instanceId: string, slug: unknown, name: unknown): void {
  if (typeof slug !== 'string' || !MODEL_ID.test(slug)) {
    return;
  }
  if (typeof name !== 'string') {
    return;
  }
  const cleaned = cleanT3ModelName(name);
  if (!cleaned) {
    return;
  }
  const instance = instanceId.trim().toLowerCase();
  if (instance) {
    names.set(`${instance}\t${slug}`, cleaned);
  }
  const bare = names.get(slug);
  if (bare === undefined) {
    names.set(slug, cleaned);
  } else if (bare !== cleaned) {
    names.set(slug, '');
  }
}

function addModelList(names: Map<string, string>, instanceId: string, models: unknown): void {
  if (!Array.isArray(models)) {
    return;
  }
  for (const model of models) {
    if (!model || typeof model !== 'object') {
      continue;
    }
    const record = model as { slug?: unknown; name?: unknown };
    rememberT3ModelName(names, instanceId, record.slug, record.name);
  }
}

let nameCache: { signature: string; names: Map<string, string> } | null = null;
let cachedLogDir: string | null = null;
let cachedLogFiles: string[] | null = null;
let cachedLogDirCheckedAt = 0;
const LOG_DIR_RESCAN_MS = 5_000;

export function invalidateT3DraftLogCache(): void {
  cachedLogFiles = null;
  cachedLogDirCheckedAt = 0;
}

export function resetT3ModelCacheForTests(): void {
  nameCache = null;
  snapshotCache = null;
  draftCache = null;
  draftFocus = null;
  logCursors = new Map();
  presenceCache = null;
  sqliteModule = undefined;
  cachedLogDir = null;
  cachedLogFiles = null;
  cachedLogDirCheckedAt = 0;
}

export function readT3ModelNames(): Map<string, string> {
  const home = getT3HomeDirectory();
  const cacheDir = getT3ModelCacheDirectory();
  const manifestFile = getT3ModelManifestFile();
  const pieces = [`manifest:${fileStamp(manifestFile)}`];
  let cacheFiles: string[] = [];
  try {
    cacheFiles = fs.readdirSync(cacheDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    for (const name of cacheFiles) {
      pieces.push(`${name}:${fileStamp(path.join(cacheDir, name))}`);
    }
  } catch (_) {
    cacheFiles = [];
  }
  const signature = `${home}|${pieces.join(',')}`;
  if (nameCache && nameCache.signature === signature) {
    return nameCache.names;
  }

  const names = new Map<string, string>();
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
      manifest?: { providers?: Record<string, { models?: unknown }> };
    };
    const providers = manifest?.manifest?.providers;
    if (providers && typeof providers === 'object') {
      for (const [instanceId, entry] of Object.entries(providers)) {
        addModelList(names, instanceId, entry?.models);
      }
    }
  } catch (_) {
    // A missing manifest still leaves the live cache files.
  }

  for (const name of cacheFiles) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8')) as {
        instanceId?: unknown;
        models?: unknown;
      };
      const instanceId = typeof parsed?.instanceId === 'string' && parsed.instanceId.trim()
        ? parsed.instanceId
        : name.slice(0, -'.json'.length);
      addModelList(names, instanceId, parsed?.models);
    } catch (_) {
      // One broken cache file does not drop the others.
    }
  }

  nameCache = { signature, names };
  return names;
}

export function lookupT3ModelName(instanceId: string | null | undefined, modelId: string): string | null {
  const names = readT3ModelNames();
  const instance = (instanceId || '').trim().toLowerCase();
  const specific = instance ? names.get(`${instance}\t${modelId}`) : undefined;
  if (specific) {
    return specific;
  }
  const bare = names.get(modelId);
  return bare || null;
}

const MODEL_SQL = `
  SELECT
    thread_id,
    json_extract(payload_json, '$.modelSelection.model') AS model,
    json_extract(payload_json, '$.modelSelection.instanceId') AS instance_id,
    json_extract(payload_json, '$.modelSelection.options') AS options_json,
    json_extract(payload_json, '$.modelSelection.effort') AS direct_effort,
    json_extract(payload_json, '$.modelSelection.reasoningEffort') AS direct_reasoning_effort,
    json_extract(payload_json, '$.modelSelection.ultracode') AS direct_ultracode,
    COALESCE(json_extract(payload_json, '$.lastVisitedAt'), updated_at) AS seen_at
  FROM orchestration_v2_projection_threads
  WHERE deleted_at IS NULL
    AND archived_at IS NULL
    AND json_valid(payload_json)
    AND typeof(json_extract(payload_json, '$.modelSelection.model')) = 'text'
  ORDER BY
    CASE WHEN json_extract(payload_json, '$.lastVisitedAt') IS NULL THEN 0 ELSE 1 END DESC,
    COALESCE(json_extract(payload_json, '$.lastVisitedAt'), updated_at) DESC
  LIMIT 1
`;

const STATUS_LIST = WORKING_STATUSES.map((status) => `'${status}'`).join(',');

// Matches T3's partial covering index `orchestration_v2_projection_runs_recovery_idx`
// (`WHERE status IN ('queued','preparing','starting','running','waiting')`), so
// active-agent discovery is an index lookup (~0.1ms) instead of a full scan of
// `orchestration_v2_projection_nodes` (~50ms on large databases).
const RUNS_AGENTS_FULL_SQL = `
  SELECT
    r.thread_id AS thread_id,
    COALESCE(
      CASE WHEN json_valid(r.payload_json) AND typeof(json_extract(r.payload_json, '$.modelSelection.model')) = 'text'
           THEN json_extract(r.payload_json, '$.modelSelection.model') END,
      CASE WHEN json_valid(t.payload_json) AND typeof(json_extract(t.payload_json, '$.modelSelection.model')) = 'text'
           THEN json_extract(t.payload_json, '$.modelSelection.model') END
    ) AS model,
    COALESCE(
      CASE WHEN json_valid(r.payload_json) AND typeof(json_extract(r.payload_json, '$.modelSelection.instanceId')) = 'text'
           THEN json_extract(r.payload_json, '$.modelSelection.instanceId') END,
      r.provider_instance_id,
      r.provider,
      CASE WHEN json_valid(t.payload_json) AND typeof(json_extract(t.payload_json, '$.modelSelection.instanceId')) = 'text'
           THEN json_extract(t.payload_json, '$.modelSelection.instanceId') END
    ) AS instance_id
  FROM orchestration_v2_projection_runs r
  INNER JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
  WHERE r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
    AND r.status <> 'waiting'
    AND t.deleted_at IS NULL
    AND t.archived_at IS NULL
  ORDER BY
    CASE r.status WHEN 'running' THEN 0 WHEN 'starting' THEN 1 WHEN 'preparing' THEN 2 ELSE 3 END,
    r.ordinal DESC
`;

const RUNS_AGENTS_BASIC_SQL = `
  SELECT DISTINCT
    r.thread_id AS thread_id,
    CASE WHEN json_valid(t.payload_json) AND typeof(json_extract(t.payload_json, '$.modelSelection.model')) = 'text'
         THEN json_extract(t.payload_json, '$.modelSelection.model') END AS model,
    CASE WHEN json_valid(t.payload_json) AND typeof(json_extract(t.payload_json, '$.modelSelection.instanceId')) = 'text'
         THEN json_extract(t.payload_json, '$.modelSelection.instanceId') END AS instance_id
  FROM orchestration_v2_projection_runs r
  INNER JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
  WHERE r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
    AND r.status <> 'waiting'
    AND t.deleted_at IS NULL
    AND t.archived_at IS NULL
`;

const SUBAGENT_RUNS_FULL_SQL = `
  SELECT
    COALESCE(
      CASE WHEN json_valid(s.payload_json) AND typeof(json_extract(s.payload_json, '$.modelSelection.model')) = 'text'
           THEN json_extract(s.payload_json, '$.modelSelection.model') END,
      CASE WHEN json_valid(s.payload_json) AND typeof(json_extract(s.payload_json, '$.model')) = 'text'
           THEN json_extract(s.payload_json, '$.model') END
    ) AS model,
    COALESCE(
      CASE WHEN json_valid(s.payload_json) AND typeof(json_extract(s.payload_json, '$.modelSelection.instanceId')) = 'text'
           THEN json_extract(s.payload_json, '$.modelSelection.instanceId') END,
      s.provider_instance_id,
      s.provider
    ) AS instance_id
  FROM orchestration_v2_projection_subagents s
  WHERE s.status IN (${STATUS_LIST})
    AND (
      s.child_thread_id IS NULL
      OR s.child_thread_id = ''
      OR NOT EXISTS (
        SELECT 1
        FROM orchestration_v2_projection_runs r
        WHERE r.thread_id = s.child_thread_id
          AND r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          AND r.status <> 'waiting'
      )
    )
`;

const SUBAGENT_RUNS_SQL = `
  SELECT COUNT(*) AS total
  FROM orchestration_v2_projection_subagents s
  WHERE s.status IN (${STATUS_LIST})
    AND (
      s.child_thread_id IS NULL
      OR s.child_thread_id = ''
      OR NOT EXISTS (
        SELECT 1
        FROM orchestration_v2_projection_runs r
        WHERE r.thread_id = s.child_thread_id
          AND r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          AND r.status <> 'waiting'
      )
    )
`;

const THREAD_AGENTS_LIST_SQL = `
  SELECT DISTINCT
    n.thread_id AS thread_id,
    CASE WHEN json_valid(t.payload_json) AND typeof(json_extract(t.payload_json, '$.modelSelection.model')) = 'text'
         THEN json_extract(t.payload_json, '$.modelSelection.model') END AS model,
    CASE WHEN json_valid(t.payload_json) AND typeof(json_extract(t.payload_json, '$.modelSelection.instanceId')) = 'text'
         THEN json_extract(t.payload_json, '$.modelSelection.instanceId') END AS instance_id
  FROM orchestration_v2_projection_nodes n
  INNER JOIN orchestration_v2_projection_threads t ON t.thread_id = n.thread_id
  WHERE n.kind = 'root_turn'
    AND n.status IN (${STATUS_LIST})
    AND t.deleted_at IS NULL
    AND t.archived_at IS NULL
`;

const SUBAGENT_NODES_FULL_SQL = `
  SELECT
    COALESCE(
      CASE WHEN json_valid(s.payload_json) AND typeof(json_extract(s.payload_json, '$.modelSelection.model')) = 'text'
           THEN json_extract(s.payload_json, '$.modelSelection.model') END,
      CASE WHEN json_valid(s.payload_json) AND typeof(json_extract(s.payload_json, '$.model')) = 'text'
           THEN json_extract(s.payload_json, '$.model') END
    ) AS model,
    COALESCE(
      CASE WHEN json_valid(s.payload_json) AND typeof(json_extract(s.payload_json, '$.modelSelection.instanceId')) = 'text'
           THEN json_extract(s.payload_json, '$.modelSelection.instanceId') END,
      s.provider_instance_id,
      s.provider
    ) AS instance_id
  FROM orchestration_v2_projection_subagents s
  WHERE s.status IN (${STATUS_LIST})
    AND (
      s.child_thread_id IS NULL
      OR s.child_thread_id = ''
      OR NOT EXISTS (
        SELECT 1
        FROM orchestration_v2_projection_nodes n
        WHERE n.thread_id = s.child_thread_id
          AND n.kind = 'root_turn'
          AND n.status IN (${STATUS_LIST})
      )
    )
`;

const SUBAGENT_SQL = `
  SELECT COUNT(*) AS total
  FROM orchestration_v2_projection_subagents s
  WHERE s.status IN (${STATUS_LIST})
    AND (
      s.child_thread_id IS NULL
      OR s.child_thread_id = ''
      OR NOT EXISTS (
        SELECT 1
        FROM orchestration_v2_projection_nodes n
        WHERE n.thread_id = s.child_thread_id
          AND n.kind = 'root_turn'
          AND n.status IN (${STATUS_LIST})
      )
    )
`;

interface T3DatabaseSnapshot extends T3PresenceSnapshot {
  threadId: string | null;
  seenAtMs: number;
}

let snapshotCache: { filePath: string; signature: string; snapshot: T3DatabaseSnapshot } | null = null;

function asModelId(value: unknown): string | null {
  return typeof value === 'string' && MODEL_ID.test(value.trim()) ? value.trim() : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function tryCountQuery(db: { prepare: (sql: string) => { get: () => any } }, sql: string): number | null {
  try {
    const row = db.prepare(sql).get() as { total?: unknown } | undefined;
    const total = Number(row?.total || 0);
    return Number.isFinite(total) && total > 0 ? total : 0;
  } catch (_) {
    return null;
  }
}

function tryAgentsQuery(
  db: { prepare: (sql: string) => { all: () => any[] } },
  sql: string,
  dedupeByThread: boolean
): T3WorkingAgent[] | null {
  try {
    const rows = db.prepare(sql).all() as Array<{
      thread_id?: unknown;
      model?: unknown;
      instance_id?: unknown;
    }>;
    const agents: T3WorkingAgent[] = [];
    const seenThreads = dedupeByThread ? new Set<string>() : null;
    for (const row of rows) {
      if (seenThreads) {
        const tid = asText(row?.thread_id);
        if (!tid || seenThreads.has(tid)) {
          continue;
        }
        seenThreads.add(tid);
      }
      agents.push({
        model: asModelId(row?.model),
        instanceId: asText(row?.instance_id)
      });
    }
    return agents;
  } catch (_) {
    return null;
  }
}

const T3_EFFORT_OPTION_IDS = new Set([
  'effort',
  'reasoningeffort',
  'reasoning_effort',
  'thought_level',
  'thoughtlevel',
  'variant'
]);

export function extractT3OptionEffort(options: unknown, fallbackRecord?: Record<string, unknown> | null): string | null {
  let parsed = options;
  if (typeof parsed === 'string' && parsed.trim()) {
    try {
      parsed = JSON.parse(parsed);
    } catch (_) {
      parsed = null;
    }
  }
  let effort: string | null = null;
  let hasUltracode = false;
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const entry = item as { id?: unknown; value?: unknown };
      const id = typeof entry.id === 'string' ? entry.id.trim().toLowerCase() : '';
      if (id === 'ultracode' && (entry.value === true || entry.value === 'true')) {
        hasUltracode = true;
      } else if (T3_EFFORT_OPTION_IDS.has(id) && typeof entry.value === 'string' && entry.value.trim()) {
        effort = entry.value.trim();
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (obj.ultracode === true || obj.ultracode === 'true') {
      hasUltracode = true;
    }
    for (const [rawKey, rawValue] of Object.entries(obj)) {
      if (T3_EFFORT_OPTION_IDS.has(rawKey.trim().toLowerCase()) && typeof rawValue === 'string' && rawValue.trim()) {
        effort = rawValue.trim();
      }
    }
  }
  if (fallbackRecord) {
    if (fallbackRecord.ultracode === true || fallbackRecord.ultracode === 1 || fallbackRecord.ultracode === 'true') {
      hasUltracode = true;
    }
    if (!effort) {
      effort = asText(fallbackRecord.effort) || asText(fallbackRecord.reasoningEffort);
    }
  }
  return mergeEffortWithUltracode(effort, hasUltracode);
}

function readSnapshot(db: { prepare: (sql: string) => { get: () => any; all: () => any[] }; close: () => void }): T3DatabaseSnapshot {
  const row = db.prepare(MODEL_SQL).get() as {
    thread_id?: unknown;
    model?: unknown;
    instance_id?: unknown;
    options_json?: unknown;
    direct_effort?: unknown;
    direct_reasoning_effort?: unknown;
    direct_ultracode?: unknown;
    seen_at?: unknown;
  } | undefined;
  const model = asModelId(row?.model);
  const instanceId = asText(row?.instance_id);
  const effort = model
    ? extractT3OptionEffort(row?.options_json, {
      effort: row?.direct_effort,
      reasoningEffort: row?.direct_reasoning_effort,
      ultracode: row?.direct_ultracode
    })
    : null;
  const seenAtMs = typeof row?.seen_at === 'string' ? Date.parse(row.seen_at) : NaN;
  // Prefer the indexed `runs` table when present; fall back to `nodes` on
  // older schemas or minimal fixtures. A missing subagent table never drops
  // the model or the root-turn count.
  const runAgents = tryAgentsQuery(db, RUNS_AGENTS_FULL_SQL, true)
    ?? tryAgentsQuery(db, RUNS_AGENTS_BASIC_SQL, true);
  const usedRuns = runAgents !== null;
  const threadAgents = runAgents ?? (tryAgentsQuery(db, THREAD_AGENTS_LIST_SQL, true) ?? []);
  let extraAgents = usedRuns
    ? tryAgentsQuery(db, SUBAGENT_RUNS_FULL_SQL, false)
    : tryAgentsQuery(db, SUBAGENT_NODES_FULL_SQL, false);
  if (extraAgents === null) {
    const extraCount = (usedRuns ? tryCountQuery(db, SUBAGENT_RUNS_SQL) : tryCountQuery(db, SUBAGENT_SQL)) ?? 0;
    extraAgents = Array.from({ length: extraCount }, () => ({ model: null, instanceId: null }));
  }
  const workingAgentModels = [...threadAgents, ...extraAgents];
  return {
    model,
    effort,
    instanceId,
    workingAgents: workingAgentModels.length,
    ...(workingAgentModels.length > 0 ? { workingAgentModels } : {}),
    threadId: asText(row?.thread_id),
    seenAtMs: Number.isFinite(seenAtMs) ? seenAtMs : 0
  };
}

function readT3DatabaseSnapshot(): T3DatabaseSnapshot | null {
  const filePath = getT3StateDatabase();
  const signature = databaseSignature(filePath);
  if (!signature) {
    if (snapshotCache?.filePath === filePath) {
      snapshotCache = null;
    }
    return null;
  }
  if (snapshotCache && snapshotCache.filePath === filePath && snapshotCache.signature === signature) {
    return snapshotCache.snapshot;
  }

  const sqlite = loadSqlite();
  if (!sqlite) {
    return snapshotCache?.filePath === filePath ? snapshotCache.snapshot : null;
  }

  let db: { close: () => void } | null = null;
  try {
    const opened = new sqlite.DatabaseSync(filePath, { readOnly: true });
    db = opened;
    const snapshot = readSnapshot(opened);
    snapshotCache = { filePath, signature, snapshot };
    return snapshot;
  } catch (_) {
    // Locked or mid-write: keep the last proven snapshot and try again next pass.
    return snapshotCache?.filePath === filePath ? snapshotCache.snapshot : null;
  } finally {
    try {
      db?.close();
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Composer drafts (the model picked before a message is sent)

const DRAFTS_KEY_SUFFIX = Buffer.from('\u0000\u0001t3code:composer-drafts:v1', 'latin1');
const LOG_BLOCK_SIZE = 32768;
const LOG_HEADER_SIZE = 7;
const MAX_LOG_BYTES = 16 * 1024 * 1024;

export interface T3Selection {
  model: string;
  effort?: string | null;
  instanceId: string;
}

export interface T3DraftEntry {
  // Thread id of a new, unsent thread; null for a draft on an existing thread.
  newThreadId: string | null;
  selection: T3Selection | null;
}

export interface T3Drafts {
  signature: string;
  stampMs: number;
  // null: the logs hold no value for the key (compacted away or never written).
  entries: Map<string, T3DraftEntry> | null;
}

let draftCache: T3Drafts | null = null;
let draftFocus: { key: string; atMs: number } | null = null;
let presenceCache: { key: string; snapshot: T3PresenceSnapshot } | null = null;

export function getT3BrowserDataDirectory(): string {
  const override = (process.env.DISCORD_CODING_STATUS_T3_BROWSER_DATA || '').trim();
  if (override) {
    return path.resolve(override);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 't3code-v2');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 't3code-v2');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 't3code-v2');
}

export function getT3LocalStorageDirectory(): string {
  return path.join(getT3BrowserDataDirectory(), 'Local Storage', 'leveldb');
}

// LevelDB write-ahead log: 32 KiB blocks of records (masked crc32c u32, length
// u16, type u8). `base` is the file offset of buf[0], so a scan can resume at
// the end of the last complete record. A torn or corrupt tail stops the scan.
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

function maskedCrc32c(type: number, data: Buffer): number {
  let crc = 0xffffffff;
  crc = CRC32C_TABLE[(crc ^ type) & 0xff] ^ (crc >>> 8);
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC32C_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
}

function scanLevelDbLog(buf: Buffer, base: number): { records: Buffer[]; consumed: number } {
  const records: Buffer[] = [];
  let pending: Buffer[] | null = null;
  let offset = 0;
  let consumed = 0;
  while (offset + LOG_HEADER_SIZE <= buf.length) {
    const left = LOG_BLOCK_SIZE - ((base + offset) % LOG_BLOCK_SIZE);
    if (left < LOG_HEADER_SIZE) {
      // Block trailer padding.
      offset += left;
      if (!pending) {
        consumed = Math.min(offset, buf.length);
      }
      continue;
    }
    const length = buf.readUInt16LE(offset + 4);
    const type = buf[offset + 6];
    const start = offset + LOG_HEADER_SIZE;
    const end = start + length;
    if (type < 1 || type > 4 || end > buf.length || length > left - LOG_HEADER_SIZE) {
      break;
    }
    const fragment = buf.subarray(start, end);
    if (buf.readUInt32LE(offset) !== maskedCrc32c(type, fragment)) {
      break;
    }
    if (type === 1) {
      records.push(fragment);
      pending = null;
    } else if (type === 2) {
      pending = [fragment];
    } else if (type === 3) {
      pending?.push(fragment);
    } else if (pending) {
      pending.push(fragment);
      records.push(Buffer.concat(pending));
      pending = null;
    }
    offset = end;
    if (!pending) {
      consumed = offset;
    }
  }
  return { records, consumed };
}

export function readLevelDbLogRecords(buf: Buffer): Buffer[] {
  return scanLevelDbLog(buf, 0).records;
}

function readVarint(buf: Buffer, offset: number): [number, number] | null {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < buf.length && shift <= 28; index += 1) {
    const byte = buf[index];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return [value, index + 1];
    }
    shift += 7;
  }
  return null;
}

function isDraftsKey(key: Buffer): boolean {
  return key[0] === 0x5f && key.length > DRAFTS_KEY_SUFFIX.length
    && key.subarray(key.length - DRAFTS_KEY_SUFFIX.length).equals(DRAFTS_KEY_SUFFIX);
}

// The drafts-key operation in one write batch: a string (put), null (delete),
// or undefined when the batch does not touch the key or is malformed. A batch
// counts only when every entry parses and the count matches its header.
function draftOperation(batch: Buffer): string | null | undefined {
  if (batch.length < 12) {
    return undefined;
  }
  const count = batch.readUInt32LE(8);
  let result: string | null | undefined;
  let seen = 0;
  let offset = 12;
  while (offset < batch.length) {
    const tag = batch[offset];
    const keyLength = readVarint(batch, offset + 1);
    if (!keyLength || (tag !== 0 && tag !== 1)) {
      return undefined;
    }
    const keyEnd = keyLength[1] + keyLength[0];
    if (keyEnd > batch.length) {
      return undefined;
    }
    const matches = isDraftsKey(batch.subarray(keyLength[1], keyEnd));
    offset = keyEnd;
    seen += 1;
    if (tag === 0) {
      if (matches) {
        result = null;
      }
      continue;
    }
    const valueLength = readVarint(batch, offset);
    if (!valueLength) {
      return undefined;
    }
    const valueEnd = valueLength[1] + valueLength[0];
    if (valueEnd > batch.length) {
      return undefined;
    }
    if (matches) {
      // Chromium stores the string as Latin-1 (prefix 1) or UTF-16LE (prefix 0).
      const value = batch.subarray(valueLength[1], valueEnd);
      result = value[0] === 1
        ? value.subarray(1).toString('latin1')
        : value[0] === 0 ? value.subarray(1).toString('utf16le') : undefined;
    }
    offset = valueEnd;
  }
  return seen === count ? result : undefined;
}

// Per log file: where the scan stopped and the drafts value seen so far, so an
// append reads only the new bytes. The value is the raw string; it is reduced
// to model fields by parseDrafts and never leaves this module.
interface LogCursor {
  offset: number;
  value: string | null | undefined;
}

let logCursors = new Map<string, LogCursor>();

function advanceLogCursor(file: string, size: number, previous: LogCursor | undefined): LogCursor {
  const cursor: LogCursor = previous && previous.offset <= size
    ? { ...previous }
    : { offset: 0, value: undefined };
  if (size <= cursor.offset) {
    return cursor;
  }
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - cursor.offset);
    const read = fs.readSync(fd, buf, 0, buf.length, cursor.offset);
    const { records, consumed } = scanLevelDbLog(buf.subarray(0, read), cursor.offset);
    for (const batch of records) {
      const operation = draftOperation(batch);
      if (operation !== undefined) {
        cursor.value = operation;
      }
    }
    cursor.offset += consumed;
  } finally {
    fs.closeSync(fd);
  }
  return cursor;
}


function selectionFrom(value: unknown, fallbackInstance: string): T3Selection | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const model = asModelId(record.model);
  if (!model) {
    return null;
  }
  const effort = extractT3OptionEffort(record.options, record);
  return {
    model,
    ...(effort ? { effort } : {}),
    instanceId: asText(record.instanceId) || fallbackInstance
  };
}

function objectOrEmpty(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

// Keeps only the model fields; the prompt text in the same value is dropped here.
function parseDrafts(text: string): Map<string, T3DraftEntry> | null {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return null;
  }
  const state = parsed?.state;
  if (!state || typeof state !== 'object') {
    return null;
  }
  const drafts = objectOrEmpty(state.draftsByThreadKey);
  const newThreads = objectOrEmpty(state.draftThreadsByThreadKey);
  const sticky = objectOrEmpty(state.stickyModelSelectionByProvider);
  const stickyProvider = asText(state.stickyActiveProvider);
  const entries = new Map<string, T3DraftEntry>();
  for (const [key, raw] of Object.entries(drafts)) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const newThread = newThreads[key];
    if (newThread && newThread.promotedTo) {
      // Already sent: the thread row in the database is the truth now.
      continue;
    }
    const provider = asText(raw.activeProvider) || (newThread ? stickyProvider : null);
    const byProvider = objectOrEmpty(raw.modelSelectionByProvider);
    const selection = provider
      ? selectionFrom(byProvider[provider], provider) || (newThread ? selectionFrom(sticky[provider], provider) : null)
      : null;
    entries.set(key, { newThreadId: newThread ? asText(newThread.threadId) || key : null, selection });
  }
  return entries;
}

function listDraftLogFiles(directory: string, allowCache: boolean): string[] {
  const now = Date.now();
  if (allowCache && cachedLogDir === directory && cachedLogFiles && cachedLogFiles.length > 0 && now - cachedLogDirCheckedAt < LOG_DIR_RESCAN_MS) {
    return cachedLogFiles;
  }
  let logs: string[] = [];
  try {
    logs = fs.readdirSync(directory)
      .filter((name) => /^\d+\.log$/.test(name))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  } catch (_) {
    logs = [];
  }
  cachedLogDir = directory;
  cachedLogFiles = logs;
  cachedLogDirCheckedAt = now;
  return logs;
}

// Stat-only fingerprint of T3's SQLite DB + active LevelDB write-ahead log.
// On Windows NTFS, non-fsynced writes to open WAL/log handles do not trigger
// fs.watch, while statSync sees the updated size/mtime immediately (~0.04ms).
export function getT3WatchStamp(): string {
  const dbSig = databaseSignature(getT3StateDatabase()) || '';
  const directory = getT3LocalStorageDirectory();
  let logs = listDraftLogFiles(directory, true);
  let logSig = '';
  if (logs.length > 0) {
    const latest = logs[logs.length - 1];
    logSig = fileStamp(path.join(directory, latest));
    if (!logSig) {
      // Log rotated out: rescan directory immediately.
      logs = listDraftLogFiles(directory, false);
      if (logs.length > 0) {
        const nextLatest = logs[logs.length - 1];
        logSig = `${nextLatest}:${fileStamp(path.join(directory, nextLatest))}`;
      }
    } else {
      logSig = `${latest}:${logSig}`;
    }
  }
  return `${dbSig}|${logSig}`;
}

export function readT3Drafts(): T3Drafts {
  const directory = getT3LocalStorageDirectory();
  const logs = listDraftLogFiles(directory, false);
  let stampMs = 0;
  const pieces: string[] = [];
  const sizes = new Map<string, number>();
  for (const name of logs) {
    try {
      const stat = fs.statSync(path.join(directory, name));
      stampMs = Math.max(stampMs, stat.mtimeMs);
      sizes.set(name, stat.size);
      pieces.push(`${name}:${stat.mtimeMs}:${stat.size}`);
    } catch (_) {}
  }
  const signature = `${directory}|${pieces.join(',')}`;
  if (draftCache && draftCache.signature === signature) {
    return draftCache;
  }

  let value: string | null | undefined;
  let failed = false;
  const cursors = new Map<string, LogCursor>();
  for (const name of logs) {
    const file = path.join(directory, name);
    const size = sizes.get(name);
    if (size === undefined || size > MAX_LOG_BYTES) {
      continue;
    }
    const previous = logCursors.get(file);
    try {
      const cursor = advanceLogCursor(file, size, previous);
      cursors.set(file, cursor);
      if (cursor.value !== undefined) {
        value = cursor.value;
      }
    } catch (_) {
      // Unreadable for now: keep what was proven and retry on the next pass.
      failed = true;
      if (previous) {
        cursors.set(file, previous);
        if (previous.value !== undefined) {
          value = previous.value;
        }
      }
    }
  }
  logCursors = cursors;
  const entries = typeof value === 'string'
    ? parseDrafts(value)
    : value === null ? new Map<string, T3DraftEntry>() : null;
  const drafts: T3Drafts = { signature: failed ? '' : signature, stampMs, entries };
  noteDraftChange(draftCache, drafts);
  draftCache = drafts;
  return drafts;
}

function selectionKey(selection: T3Selection | null): string {
  return selection ? `${selection.instanceId}\t${selection.model}\t${selection.effort || ''}` : '';
}

// The draft whose model just changed, or that just appeared, is the one on
// screen. Several changing at once proves nothing, so the focus stays put.
function noteDraftChange(previous: T3Drafts | null, next: T3Drafts): void {
  if (!next.entries) {
    return;
  }
  if (draftFocus && !next.entries.get(draftFocus.key)?.selection) {
    draftFocus = null;
  }
  if (!previous?.entries) {
    return;
  }
  const changed: string[] = [];
  for (const [key, entry] of next.entries) {
    if (!entry.selection) {
      continue;
    }
    const before = previous.entries.get(key);
    if (!before || selectionKey(before.selection) !== selectionKey(entry.selection)) {
      changed.push(key);
    }
  }
  if (changed.length === 1) {
    draftFocus = { key: changed[0], atMs: next.stampMs };
  }
}

// Existing threads are keyed `<environmentId>:<threadId>`.
function draftForThread(entries: Map<string, T3DraftEntry>, threadId: string): T3DraftEntry | null {
  for (const [key, entry] of entries) {
    if (entry.newThreadId === null && (key === threadId || key.endsWith(`:${threadId}`))) {
      return entry;
    }
  }
  return null;
}

export function readT3Presence(): T3PresenceSnapshot | null {
  const database = readT3DatabaseSnapshot();
  const drafts = readT3Drafts();
  let selection: T3Selection | null = null;
  let source = 'db';

  const focused = draftFocus ? drafts.entries?.get(draftFocus.key) : undefined;
  if (draftFocus && focused?.selection && (!database || draftFocus.atMs > database.seenAtMs)) {
    // A pick made after the database's last visit is the screen the user is on.
    selection = focused.selection;
    source = `focus:${draftFocus.key}`;
  } else if (database?.threadId && drafts.entries) {
    // An unsent pick on the thread on screen is what its next turn will use.
    const pending = draftForThread(drafts.entries, database.threadId);
    if (pending?.selection) {
      selection = pending.selection;
      source = 'pending';
    }
  }

  if (!database && !selection) {
    presenceCache = null;
    return null;
  }

  const model = selection ? selection.model : database?.model ?? null;
  const effort = selection ? (selection.effort ?? null) : (database?.effort ?? null);
  const instanceId = selection ? selection.instanceId : database?.instanceId ?? null;
  const workingAgents = database?.workingAgents ?? 0;
  const workingAgentModels = database?.workingAgentModels;
  const agentsKey = workingAgentModels?.map((agent) => `${agent.instanceId || ''}:${agent.model || ''}`).join(',') || '';
  const cacheKey = `${source}\t${model}\t${effort || ''}\t${instanceId}\t${workingAgents}\t${agentsKey}`;
  if (presenceCache && presenceCache.key === cacheKey) {
    return presenceCache.snapshot;
  }
  const snapshot: T3PresenceSnapshot = {
    model,
    ...(effort ? { effort } : {}),
    instanceId,
    workingAgents,
    ...(workingAgentModels && workingAgentModels.length > 0 ? { workingAgentModels } : {})
  };
  presenceCache = { key: cacheKey, snapshot };
  return snapshot;
}
