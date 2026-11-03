'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// OpenCode stores the model picker's history in <state>/opencode/model.json:
// { recent: [{ providerID, modelID }, ...] }, newest first. recent[0] is the
// model a session uses until the user picks another, so with one OpenCode
// process alive it is that process's model. The name shown in OpenCode's
// status bar comes from its models.dev cache (<cache>/opencode/models.json,
// providers[providerID].models[modelID].name).

export interface OpenCodeModel {
  model: string;
  filePath: string;
  mtimeMs: number;
}

function xdgDir(envName: string, fallback: string[]): string {
  const configured = String(process.env[envName] || '').trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ...fallback);
}

export function getOpenCodeStateFile(): string {
  const override = String(process.env.DISCORD_CODING_STATUS_OPENCODE_STATE || '').trim();
  return override
    ? path.resolve(override)
    : path.join(xdgDir('XDG_STATE_HOME', ['.local', 'state']), 'opencode', 'model.json');
}

export function getOpenCodeModelsCacheFile(): string {
  const override = String(process.env.DISCORD_CODING_STATUS_OPENCODE_MODELS_CACHE || '').trim();
  return override
    ? path.resolve(override)
    : path.join(xdgDir('XDG_CACHE_HOME', ['.cache']), 'opencode', 'models.json');
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,120}$/;

export function parseOpenCodeRecentModel(json: unknown): { providerID: string; modelID: string } | null {
  const first = Array.isArray((json as { recent?: unknown })?.recent) ? (json as { recent: unknown[] }).recent[0] : null;
  const providerID = (first as { providerID?: unknown })?.providerID;
  const modelID = (first as { modelID?: unknown })?.modelID;
  if (typeof providerID !== 'string' || typeof modelID !== 'string' || !ID.test(providerID) || !ID.test(modelID)) {
    return null;
  }
  return { providerID, modelID };
}

let stateCache: { filePath: string; mtimeMs: number; pick: { providerID: string; modelID: string } | null } | null = null;
let namesCache: { filePath: string; mtimeMs: number; names: Map<string, string> } | null = null;

function readModelName(providerID: string, modelID: string): string | null {
  const filePath = getOpenCodeModelsCacheFile();
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    if (!namesCache || namesCache.filePath !== filePath || namesCache.mtimeMs !== mtimeMs) {
      const names = new Map<string, string>();
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, { models?: Record<string, { name?: unknown }> }>;
      for (const [provider, entry] of Object.entries(parsed || {})) {
        for (const [model, info] of Object.entries(entry?.models || {})) {
          if (typeof info?.name === 'string' && info.name.trim()) {
            names.set(`${provider}/${model}`, info.name.trim());
          }
        }
      }
      namesCache = { filePath, mtimeMs, names };
    }
    return namesCache.names.get(`${providerID}/${modelID}`) || null;
  } catch (_) {
    return null;
  }
}

// Returns the picker's display name ("DeepSeek V4.1 Flash Free"), or the raw
// model id when the models cache does not name it.
export function readOpenCodeModel(): OpenCodeModel | null {
  const filePath = getOpenCodeStateFile();
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    if (!stateCache || stateCache.filePath !== filePath || stateCache.mtimeMs !== mtimeMs) {
      stateCache = { filePath, mtimeMs, pick: parseOpenCodeRecentModel(JSON.parse(fs.readFileSync(filePath, 'utf8'))) };
    }
    const pick = stateCache.pick;
    if (!pick) {
      return null;
    }
    return { model: readModelName(pick.providerID, pick.modelID) || pick.modelID, filePath, mtimeMs };
  } catch (_) {
    return null;
  }
}
