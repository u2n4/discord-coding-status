'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

/** Session files have no process binding, so they cannot establish an active model. */
export function readActiveMuseModel(_freshAfterMs: number): MuseModelResult | null {
  return null;
}
