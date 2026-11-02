'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';

import { getCodexHomeDirectory } from './codex/model';
import { getGrokHomeDirectory } from './grok/model';

// Turns a resolved model id into the label the tool itself shows, so Discord
// reads the same as the model picker the user just used. Each tool's own
// model list is the source where one exists (Codex and Grok cache the names
// their pickers display); effort/tier suffixes and context-window tags are
// dropped. Ids that match nothing are returned unchanged.

const CLAUDE_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-[a-z0-9@-]+)?(?:\[[^\]]*\])?$/i;
const GEMINI_ID = /^gemini-(\d+(?:\.\d+)?)-([a-z]+)(?:-[a-z0-9@.-]+)?$/i;
const GPT_OSS_ID = /^gpt-oss-(\d+b)(?:-[a-z]+)?$/i;
const EFFORT_SUFFIX = /\s*\((?:low|medium|high|max|xhigh|thinking)\)\s*$/i;
const MUSE_ID = /^(?:meta\.)?muse-([a-z]+)-(\d+(?:\.\d+)?)(?:-[a-z]+)?$/i;

export interface ModelLabelSurface {
  family?: string;
  providerId?: string;
}

function titleWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function claudeLabel(model: string): string | null {
  const match = model.match(CLAUDE_ID);
  if (!match) {
    return null;
  }
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `${titleWord(match[1])} ${version}`;
}

// --- tool-owned model lists, re-read only when the file changes ------------

interface CachedNames {
  filePath: string;
  mtimeMs: number;
  names: Map<string, string>;
}

const nameCaches = new Map<string, CachedNames>();

function readNames(key: string, filePath: string, parse: (json: any) => Map<string, string>): Map<string, string> {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch (_) {
    nameCaches.delete(key);
    return new Map();
  }
  const cached = nameCaches.get(key);
  if (cached && cached.filePath === filePath && cached.mtimeMs === mtimeMs) {
    return cached.names;
  }
  let names = new Map<string, string>();
  try {
    names = parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (_) {
    names = new Map();
  }
  nameCaches.set(key, { filePath, mtimeMs, names });
  return names;
}

function codexNames(): Map<string, string> {
  return readNames('codex', path.join(getCodexHomeDirectory(), 'models_cache.json'), (json) => {
    const names = new Map<string, string>();
    const models = Array.isArray(json) ? json : Array.isArray(json?.models) ? json.models : [];
    for (const model of models) {
      if (typeof model?.slug === 'string' && typeof model?.display_name === 'string' && model.display_name.trim()) {
        names.set(model.slug, model.display_name.trim());
      }
    }
    return names;
  });
}

function grokNames(): Map<string, string> {
  return readNames('grok', path.join(getGrokHomeDirectory(), 'models_cache.json'), (json) => {
    const names = new Map<string, string>();
    const models = json?.models && typeof json.models === 'object' ? json.models : {};
    for (const [id, entry] of Object.entries(models as Record<string, any>)) {
      const name = entry?.info?.name;
      if (typeof name === 'string' && name.trim()) {
        names.set(id, name.trim());
      }
    }
    return names;
  });
}

export function resetModelLabelCacheForTests(): void {
  nameCaches.clear();
}

// --- per tool ---------------------------------------------------------------

function codexLabel(id: string, providerId: string | undefined): string {
  // Codex CLI pickers show models_cache.json's display_name ("GPT-6.1-Sol");
  // the Desktop app separates the variant word ("GPT-6.1 Sol").
  // A slug missing from that list is shown as-is rather than guessed.
  const label = codexNames().get(id);
  if (!label) {
    return id;
  }
  return providerId === 'codexApp' ? label.replace(/-(?=[A-Z][a-z]+$)/, ' ') : label;
}

export function displayModelLabel(surface: string | ModelLabelSurface | undefined, model: string): string {
  const { family, providerId } = typeof surface === 'string' || surface === undefined
    ? { family: surface, providerId: undefined }
    : surface;
  const id = model.trim();
  if (!id) {
    return id;
  }

  if (family === 'claude') {
    // Claude Code and Claude Desktop both show "Opus 5.5".
    return claudeLabel(id) || id;
  }

  if (family === 'antigravity') {
    // Antigravity lists "Claude Opus 5.5 (High)", "Gemini 4 Argon (Medium)",
    // "GPT-OSS 120B (Medium)" (`agy models`); the effort in brackets is dropped.
    if (/\s/.test(id)) {
      // Already a picker label (agy logs "Gemini 4 Argon (Medium)").
      return id.replace(EFFORT_SUFFIX, '');
    }
    const claude = claudeLabel(id);
    if (claude) {
      return `Claude ${claude}`;
    }
    const gemini = id.match(GEMINI_ID);
    if (gemini) {
      return `Gemini ${gemini[1]} ${titleWord(gemini[2])}`;
    }
    const gptOss = id.match(GPT_OSS_ID);
    if (gptOss) {
      return `GPT-OSS ${gptOss[1].toUpperCase()}`;
    }
    return id;
  }

  if (family === 'codex') {
    return codexLabel(id, providerId);
  }

  if (family === 'grok') {
    // Grok Build lists "Grok 4.7" for grok-4.7.
    return grokNames().get(id) || id;
  }

  if (family === 'muse') {
    // Muse Code names the family "Muse Spark"; the contributor/internal
    // variant is a billing mode, not part of the model name.
    const muse = id.match(MUSE_ID);
    return muse ? `Muse ${titleWord(muse[1])} ${muse[2]}` : id;
  }

  return id;
}
