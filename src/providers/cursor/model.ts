'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { cursorStateDbPath } from './quota';

// Cursor keeps its settings in User/globalStorage/state.vscdb (SQLite). The
// applicationUser blob holds both the Agent chat pick
// (aiSettings.modelConfig.composer.modelName) and the list the picker renders
// (availableDefaultModels2: serverModelName -> inputboxShortModelName), so the
// pick is shown exactly as Cursor's input box writes it ("Auto",
// "Claude Opus 5.5"). Read with node:sqlite, re-read only when the database
// or its WAL changes.

const APPLICATION_USER_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

export interface CursorModel {
  model: string;
  filePath: string;
  mtimeMs: number;
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

export function getCursorStateDatabase(): string {
  const override = String(process.env.DISCORD_CODING_STATUS_CURSOR_STATE_DB || '').trim();
  if (override) {
    return path.resolve(override);
  }
  return cursorStateDbPath();
}

export function parseCursorApplicationUser(json: unknown): string | null {
  const user = json as {
    aiSettings?: { modelConfig?: { composer?: { modelName?: unknown } } };
    availableDefaultModels2?: Array<{ serverModelName?: unknown; name?: unknown; inputboxShortModelName?: unknown }>;
  } | null;
  const picked = user?.aiSettings?.modelConfig?.composer?.modelName;
  if (typeof picked !== 'string' || !picked.trim()) {
    return null;
  }
  const id = picked.trim();
  const entry = (Array.isArray(user?.availableDefaultModels2) ? user!.availableDefaultModels2! : [])
    .find((model) => model?.serverModelName === id || model?.name === id);
  const label = typeof entry?.inputboxShortModelName === 'string' ? entry.inputboxShortModelName.trim() : '';
  if (label && label.length <= 80) {
    return label;
  }
  // Cursor's own name for the automatic router.
  return id === 'default' ? 'Auto' : id;
}

let cache: { filePath: string; signature: string; model: string | null } | null = null;

function fileSignature(filePath: string): string | null {
  try {
    const main = fs.statSync(filePath);
    let wal = '';
    try {
      const walStat = fs.statSync(`${filePath}-wal`);
      wal = `${walStat.mtimeMs}:${walStat.size}`;
    } catch (_) {}
    return `${main.mtimeMs}:${main.size}|${wal}`;
  } catch (_) {
    return null;
  }
}

export function readCursorModel(): CursorModel | null {
  const filePath = getCursorStateDatabase();
  const signature = fileSignature(filePath);
  if (!signature) {
    cache = null;
    return null;
  }
  if (!cache || cache.filePath !== filePath || cache.signature !== signature) {
    const sqlite = loadSqlite();
    if (!sqlite) {
      return null;
    }
    let db: any = null;
    try {
      db = new sqlite.DatabaseSync(filePath, { readOnly: true });
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(APPLICATION_USER_KEY) as { value?: unknown } | undefined;
      const text = typeof row?.value === 'string' ? row.value : row?.value ? Buffer.from(row.value as Uint8Array).toString('utf8') : '';
      cache = { filePath, signature, model: text ? parseCursorApplicationUser(JSON.parse(text)) : null };
    } catch (_) {
      // Locked or mid-write: nothing is cached, so the next pass reads again.
      return null;
    } finally {
      try {
        db?.close();
      } catch (_) {}
    }
  }
  return cache.model ? { model: cache.model, filePath, mtimeMs: Date.now() } : null;
}
