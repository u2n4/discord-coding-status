'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AntigravityModelResult {
  model: string;
  filePath: string;
  mtimeMs: number;
}

export function getAntigravityHomeDir(): string {
  const override = String(process.env.DISCORD_CODING_STATUS_ANTIGRAVITY_HOME || '').trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

export function normalizeAntigravityModel(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const stripped = value
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) {
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/.test(stripped)) {
    return null;
  }
  const lower = stripped.toLowerCase();
  if (
    lower === 'unknown'
    || lower === 'default'
    || lower === 'inherit'
    || lower === 'auto'
    || lower === 'none'
  ) {
    return null;
  }
  return stripped;
}

interface TranscriptCandidate {
  filePath: string;
  mtimeMs: number;
}

let cachedActiveTranscript: { home: string; filePath: string | null; expiresAt: number } | null = null;
let cachedBrainCandidates: { home: string; candidates: TranscriptCandidate[]; expiresAt: number } | null = null;

function listBrainTranscriptCandidates(antigravityHome: string): TranscriptCandidate[] {
  const now = Date.now();
  if (
    cachedBrainCandidates
    && cachedBrainCandidates.home === antigravityHome
    && cachedBrainCandidates.expiresAt > now
  ) {
    return cachedBrainCandidates.candidates;
  }

  const brainDir = path.join(antigravityHome, 'brain');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(brainDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const candidates: TranscriptCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const transcriptFile = path.join(
      brainDir,
      entry.name,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    try {
      const stat = fs.statSync(transcriptFile);
      if (stat.isFile()) {
        candidates.push({ filePath: transcriptFile, mtimeMs: stat.mtimeMs });
      }
    } catch (_) {
      // Ignore conversations without a transcript file.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  cachedBrainCandidates = { home: antigravityHome, candidates, expiresAt: now + 3000 };
  return candidates;
}

export function findActiveAntigravityTranscriptFile(): string | null {
  const antigravityHome = getAntigravityHomeDir();
  const now = Date.now();
  if (
    cachedActiveTranscript
    && cachedActiveTranscript.home === antigravityHome
    && cachedActiveTranscript.expiresAt > now
  ) {
    return cachedActiveTranscript.filePath;
  }

  const presenceDir = path.join(antigravityHome, 'presence');
  try {
    const lockEntries = fs.readdirSync(presenceDir, { withFileTypes: true });
    const locks: TranscriptCandidate[] = [];
    for (const entry of lockEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.lock')) {
        continue;
      }
      const conversationId = entry.name.slice(0, -'.lock'.length);
      const transcriptFile = path.join(
        antigravityHome,
        'brain',
        conversationId,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );
      try {
        const stat = fs.statSync(transcriptFile);
        if (stat.isFile()) {
          locks.push({ filePath: transcriptFile, mtimeMs: stat.mtimeMs });
        }
      } catch (_) {
        // Ignore stale locks without transcripts.
      }
    }
    if (locks.length > 0) {
      locks.sort((left, right) => right.mtimeMs - left.mtimeMs);
      const best = locks[0].filePath;
      cachedActiveTranscript = { home: antigravityHome, filePath: best, expiresAt: now + 1500 };
      return best;
    }
  } catch (_) {
    // Fall back to brain scan when presence directory is absent.
  }

  const candidates = listBrainTranscriptCandidates(antigravityHome);
  const best = candidates[0]?.filePath || null;
  cachedActiveTranscript = { home: antigravityHome, filePath: best, expiresAt: now + 1500 };
  return best;
}

// Antigravity writes the dropdown pick to antigravity_state.pbtxt as an opaque
// placeholder (MODEL_PLACEHOLDER_M402). Its own generation records
// (conversations/<id>.db, table gen_metadata) pair that placeholder with the
// provider model id that actually served the turn (claude-opus-5-5-high), so
// the daemon learns the mapping from those records instead of guessing from
// labels. Seeds below were read from those records on 2026-11-03; a
// placeholder never seen in a record stays unresolved (app-only).
export const ANTIGRAVITY_PLACEHOLDER_SEED: Readonly<Record<string, string>> = Object.freeze({
  MODEL_PLACEHOLDER_M26: 'claude-opus-4-6-thinking',
  MODEL_PLACEHOLDER_M71: 'gemini-3.6-flash',
  MODEL_PLACEHOLDER_M132: 'gemini-3-flash-a',
  MODEL_PLACEHOLDER_M133: 'gemini-3-flash-b',
  MODEL_PLACEHOLDER_M298: 'gemini-3.7-flash',
  MODEL_PLACEHOLDER_M318: 'gemini-3.8-flash-n',
  MODEL_PLACEHOLDER_M401: 'claude-opus-5-5-medium',
  MODEL_PLACEHOLDER_M402: 'claude-opus-5-5-high',
  MODEL_PLACEHOLDER_M417: 'gemini-4-argon-trial',
  MODEL_PLACEHOLDER_M418: 'gemini-4-argon-trial'
});

const PLACEHOLDER_PATTERN = /MODEL_PLACEHOLDER_M[1-9]\d*/;
const PROVIDER_MODEL_PATTERN = /\b((?:claude|gemini|gpt)-[a-z0-9][a-z0-9.@-]{2,48})/;
const MAX_LEARN_DATABASES = 8;
const MAX_LEARN_ROWS = 300;
const MAX_LEARN_ROW_BYTES = 20_000;
const LEARN_RESCAN_MS = 5_000;

interface LearnedDatabase {
  mtimeMs: number;
  size: number;
  counts: Map<string, Map<string, number>>;
}

const learnedDatabases = new Map<string, LearnedDatabase>();
let learnedMap: { home: string; map: Map<string, string>; expiresAt: number } | null = null;

type SqliteModule = { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => any };
let sqliteModule: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) {
    return sqliteModule;
  }
  try {
    // node:sqlite ships with Node 22.5+; older runtimes (no getBuiltinModule or
    // no sqlite builtin) keep the seed map only.
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    sqliteModule = (typeof getBuiltin === 'function' ? getBuiltin.call(process, 'node:sqlite') as SqliteModule : null) || null;
  } catch (_) {
    sqliteModule = null;
  }
  return sqliteModule;
}

// One gen_metadata blob -> [placeholder, provider model id], or null.
export function pairFromGenerationRecord(blob: Uint8Array | null | undefined): [string, string] | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength > MAX_LEARN_ROW_BYTES) {
    return null;
  }
  const text = Buffer.from(blob).toString('latin1');
  const placeholder = text.match(PLACEHOLDER_PATTERN)?.[0];
  const providerModel = text.match(PROVIDER_MODEL_PATTERN)?.[1];
  if (!placeholder || !providerModel) {
    return null;
  }
  return [placeholder, providerModel];
}

function learnFromDatabase(sqlite: SqliteModule, filePath: string, stat: fs.Stats): LearnedDatabase {
  const counts = new Map<string, Map<string, number>>();
  let db: any = null;
  try {
    db = new sqlite.DatabaseSync(filePath, { readOnly: true });
    const rows = db
      .prepare('SELECT data FROM gen_metadata WHERE size > 0 AND size <= ? ORDER BY idx DESC LIMIT ?')
      .all(MAX_LEARN_ROW_BYTES, MAX_LEARN_ROWS) as Array<{ data: Uint8Array | null }>;
    for (const row of rows) {
      const pair = pairFromGenerationRecord(row.data);
      if (!pair) {
        continue;
      }
      const byModel = counts.get(pair[0]) || new Map<string, number>();
      byModel.set(pair[1], (byModel.get(pair[1]) || 0) + 1);
      counts.set(pair[0], byModel);
    }
  } catch (_) {
    // Locked, mid-write or foreign schema: learn nothing from this file.
  } finally {
    try {
      db?.close();
    } catch (_) {}
  }
  return { mtimeMs: stat.mtimeMs, size: stat.size, counts };
}

export function resetAntigravityModelLearning(): void {
  learnedDatabases.clear();
  learnedMap = null;
}

function readLearnedPlaceholderMap(): Map<string, string> {
  const home = getAntigravityHomeDir();
  const now = Date.now();
  if (learnedMap && learnedMap.home === home && learnedMap.expiresAt > now) {
    return learnedMap.map;
  }

  const merged = new Map<string, Map<string, number>>();
  const sqlite = loadSqlite();
  if (sqlite) {
    const dir = path.join(home, 'conversations');
    let files: Array<{ filePath: string; stat: fs.Stats }> = [];
    try {
      files = fs.readdirSync(dir)
        .filter((name) => name.endsWith('.db'))
        .map((name) => {
          const filePath = path.join(dir, name);
          try {
            return { filePath, stat: fs.statSync(filePath) };
          } catch (_) {
            return null;
          }
        })
        .filter((entry): entry is { filePath: string; stat: fs.Stats } => Boolean(entry?.stat.isFile()))
        .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
        .slice(0, MAX_LEARN_DATABASES);
    } catch (_) {
      files = [];
    }
    for (const { filePath, stat } of files) {
      let learned = learnedDatabases.get(filePath);
      if (!learned || learned.mtimeMs !== stat.mtimeMs || learned.size !== stat.size) {
        learned = learnFromDatabase(sqlite, filePath, stat);
        learnedDatabases.set(filePath, learned);
      }
      for (const [placeholder, byModel] of learned.counts) {
        const target = merged.get(placeholder) || new Map<string, number>();
        for (const [model, count] of byModel) {
          target.set(model, (target.get(model) || 0) + count);
        }
        merged.set(placeholder, target);
      }
    }
  }

  const map = new Map<string, string>(Object.entries(ANTIGRAVITY_PLACEHOLDER_SEED));
  for (const [placeholder, byModel] of merged) {
    const best = [...byModel.entries()].sort((left, right) => right[1] - left[1])[0];
    if (best) {
      map.set(placeholder, best[0]);
    }
  }
  learnedMap = { home, map, expiresAt: now + LEARN_RESCAN_MS };
  return map;
}

export function getAntigravityStateFile(): string {
  return path.join(getAntigravityHomeDir(), 'antigravity_state.pbtxt');
}

export function parseAntigravityStatePlaceholder(text: string): string | null {
  const match = text ? text.match(/last_selected_agent_model:\s*([A-Za-z0-9_]+)/) : null;
  return match?.[1]?.trim() || null;
}

export function resolveAntigravityPlaceholder(placeholder: string | null): string | null {
  if (!placeholder) {
    return null;
  }
  return readLearnedPlaceholderMap().get(placeholder) || null;
}

export function parseAntigravityStateModel(text: string): string | null {
  return resolveAntigravityPlaceholder(parseAntigravityStatePlaceholder(text));
}

export function readAntigravityStateModel(): AntigravityModelResult | null {
  const filePath = getAntigravityStateFile();
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    const model = parseAntigravityStateModel(fs.readFileSync(filePath, 'utf8'));
    if (!model) {
      return null;
    }
    return {
      model,
      filePath,
      mtimeMs: stat.mtimeMs
    };
  } catch (_) {
    return null;
  }
}

// The UI selection is the only model source: conversation transcripts carry
// user text and tool output, so they are never mined for a model name. The
// argument is kept for callers that pass a transcript path; it is ignored.
export function readActiveAntigravityModel(_transcriptPath?: string | null): AntigravityModelResult | null {
  return readAntigravityStateModel();
}
