'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AntigravityModelResult {
  model: string;
  filePath: string;
  mtimeMs: number;
}

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

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

const MODEL_SELECTION_REGEX = /changed setting `Model Selection` from [^\r\n]+? to `?([A-Za-z0-9][A-Za-z0-9 ._()+-]*?)(?:`|\.(?:\s|$)|[\r\n<]|$)/i;

export function extractAntigravityModelFromTranscriptJsonl(text: string): string | null {
  if (!text) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || !line.includes('Model Selection')) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        const source = typeof parsed.source === 'string' ? parsed.source : '';
        const type = typeof parsed.type === 'string' ? parsed.type : '';
        if (source === 'MODEL' || type === 'PLANNER_RESPONSE' || type === 'GENERIC') {
          continue;
        }
      }
      const content = typeof parsed?.content === 'string' ? parsed.content : '';
      if (!content) {
        continue;
      }
      const match = content.match(MODEL_SELECTION_REGEX);
      if (match?.[1]) {
        const normalized = normalizeAntigravityModel(match[1]);
        if (normalized) {
          return normalized;
        }
      }
    } catch (_) {
      if (line.includes('"source":"MODEL"') || line.includes('"type":"GENERIC"')) {
        continue;
      }
      const match = line.match(MODEL_SELECTION_REGEX);
      if (match?.[1]) {
        const normalized = normalizeAntigravityModel(match[1]);
        if (normalized) {
          return normalized;
        }
      }
    }
  }
  return null;
}

function readTranscriptSlices(filePath: string): { head: string; tail: string } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0) {
      return { head: '', tail: '' };
    }
    const tailLength = Math.min(stat.size, TAIL_BYTES);
    const tailOffset = Math.max(0, stat.size - tailLength);
    const tailBuffer = Buffer.alloc(tailLength);
    const tailBytesRead = fs.readSync(fd, tailBuffer, 0, tailLength, tailOffset);
    const tail = tailBuffer.subarray(0, tailBytesRead).toString('utf8');

    if (tailOffset === 0) {
      return { head: '', tail };
    }

    const headLength = Math.min(tailOffset, HEAD_BYTES);
    const headBuffer = Buffer.alloc(headLength);
    const headBytesRead = fs.readSync(fd, headBuffer, 0, headLength, 0);
    const head = headBuffer.subarray(0, headBytesRead).toString('utf8');
    return { head, tail };
  } catch (_) {
    return { head: '', tail: '' };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        // Ignore close errors.
      }
    }
  }
}

interface TranscriptCandidate {
  filePath: string;
  mtimeMs: number;
}

interface CachedTranscriptModel {
  mtimeMs: number;
  size: number;
  model: string | null;
}

const transcriptModelCache = new Map<string, CachedTranscriptModel>();
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

export const ANTIGRAVITY_PLACEHOLDER_MAP: Readonly<Record<string, string>> = Object.freeze({
  MODEL_PLACEHOLDER_M124: 'Gemini 3.8 Flash',
  MODEL_PLACEHOLDER_M317: 'Gemini 3.8 Flash',
  MODEL_PLACEHOLDER_M318: 'Gemini 3.8 Flash',
  MODEL_PLACEHOLDER_M319: 'Gemini 3.8 Flash',
  MODEL_PLACEHOLDER_M320: 'Gemini 3.8 Flash',
  MODEL_PLACEHOLDER_M322: 'Gemini 3.8 Flash',
  MODEL_PLACEHOLDER_M298: 'Gemini 3.7 Flash',
  MODEL_PLACEHOLDER_M299: 'Gemini 3.7 Flash',
  MODEL_PLACEHOLDER_M300: 'Gemini 3.7 Flash',
  MODEL_PLACEHOLDER_M71: 'Gemini 3.6 Flash',
  MODEL_PLACEHOLDER_M72: 'Gemini 3.6 Flash',
  MODEL_PLACEHOLDER_M73: 'Gemini 3.6 Flash',
  MODEL_PLACEHOLDER_M196: 'Gemini 3.6 Flash',
  MODEL_PLACEHOLDER_M20: 'Gemini 3.5 Flash',
  MODEL_PLACEHOLDER_M149: 'Gemini 3.5 Flash',
  MODEL_PLACEHOLDER_M187: 'Gemini 3.5 Flash',
  MODEL_PLACEHOLDER_M408: 'Gemini 4 Argon',
  MODEL_PLACEHOLDER_M409: 'Gemini 4 Argon',
  MODEL_PLACEHOLDER_M410: 'Gemini 4 Argon',
  MODEL_PLACEHOLDER_M411: 'Gemini 4 Argon',
  MODEL_PLACEHOLDER_M412: 'Gemini 4 Argon',
  MODEL_PLACEHOLDER_M413: 'Gemini 4 Argon',
  MODEL_PLACEHOLDER_M417: 'Gemini 4 Argon',
  MODEL_PLACEHOLDER_M418: 'Gemini 4 Argon',
  MODEL_PLACEHOLDER_M419: 'Gemini 4 Argon',
  MODEL_PLACEHOLDER_M420: 'Gemini 4 Argon',
  MODEL_PLACEHOLDER_M421: 'Gemini 4 Argon',
  MODEL_PLACEHOLDER_M400: 'Claude Opus 5.5',
  MODEL_PLACEHOLDER_M401: 'Claude Opus 5.5',
  MODEL_PLACEHOLDER_M402: 'Claude Opus 5.5',
  MODEL_PLACEHOLDER_M406: 'Claude Opus 5.5',
  MODEL_PLACEHOLDER_M403: 'Claude Sonnet 5.5',
  MODEL_PLACEHOLDER_M404: 'Claude Sonnet 5.5',
  MODEL_PLACEHOLDER_M405: 'Claude Sonnet 5.5',
  MODEL_PLACEHOLDER_M407: 'Claude Sonnet 5.5',
  MODEL_PLACEHOLDER_M26: 'Claude Opus 4.6',
  MODEL_PLACEHOLDER_M35: 'Claude Sonnet 4.6',
  MODEL_PLACEHOLDER_M18: 'Gemini 3.1 Pro',
  MODEL_PLACEHOLDER_M148: 'Gemini 3.1 Pro',
  MODEL_GOOGLE_GEMINI_2_5_PRO: 'Gemini 3.1 Pro',
  MODEL_PLACEHOLDER_M50: 'Gemini 2.5 Flash',
  MODEL_PLACEHOLDER_M198: 'Gemini 2.5 Flash',
  MODEL_GOOGLE_GEMINI_2_5_FLASH: 'Gemini 2.5 Flash',
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 'GPT OSS 120B'
});

export function getAntigravityStateFile(): string {
  return path.join(getAntigravityHomeDir(), 'antigravity_state.pbtxt');
}

export function parseAntigravityStateModel(text: string): string | null {
  if (!text) {
    return null;
  }
  const match = text.match(/last_selected_agent_model:\s*([A-Za-z0-9_]+)/);
  if (!match?.[1]) {
    return null;
  }
  const placeholder = match[1].trim();
  if (ANTIGRAVITY_PLACEHOLDER_MAP[placeholder]) {
    return ANTIGRAVITY_PLACEHOLDER_MAP[placeholder];
  }
  return normalizeAntigravityModel(placeholder);
}

export function readAntigravityStateModel(): AntigravityModelResult | null {
  const filePath = getAntigravityStateFile();
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const model = parseAntigravityStateModel(text);
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

export function readActiveAntigravityModel(
  explicitTranscriptPath?: string | null
): AntigravityModelResult | null {
  const stateModel = readAntigravityStateModel();
  if (stateModel) {
    return stateModel;
  }

  const tried = new Set<string>();
  const checkFile = (filePath: string): AntigravityModelResult | null => {
    const resolved = path.resolve(filePath);
    if (tried.has(resolved)) {
      return null;
    }
    tried.add(resolved);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch (_) {
      transcriptModelCache.delete(resolved);
      return null;
    }
    if (!stat.isFile()) {
      return null;
    }
    const prev = transcriptModelCache.get(resolved);
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
      return prev.model ? { model: prev.model, filePath: resolved, mtimeMs: stat.mtimeMs } : null;
    }
    const { head, tail } = readTranscriptSlices(resolved);
    const extracted =
      extractAntigravityModelFromTranscriptJsonl(tail)
      || extractAntigravityModelFromTranscriptJsonl(head);
    const model = extracted || (prev && stat.size >= prev.size ? prev.model : null);
    transcriptModelCache.set(resolved, { mtimeMs: stat.mtimeMs, size: stat.size, model });
    if (!model) {
      return null;
    }
    return {
      model,
      filePath: resolved,
      mtimeMs: stat.mtimeMs
    };
  };

  if (explicitTranscriptPath && explicitTranscriptPath.trim()) {
    const direct = checkFile(explicitTranscriptPath.trim());
    if (direct) {
      return direct;
    }
  }

  const activeFile = findActiveAntigravityTranscriptFile();
  let activeMtimeMs = 0;
  if (activeFile) {
    try {
      activeMtimeMs = fs.statSync(activeFile).mtimeMs;
    } catch (_) {
      activeMtimeMs = 0;
    }
    const fromActive = checkFile(activeFile);
    if (fromActive) {
      return fromActive;
    }
  }

  const candidates = listBrainTranscriptCandidates(getAntigravityHomeDir());
  for (const candidate of candidates.slice(0, 15)) {
    const found = checkFile(candidate.filePath);
    if (found) {
      return {
        model: found.model,
        filePath: activeFile || found.filePath,
        mtimeMs: Math.max(activeMtimeMs, found.mtimeMs)
      };
    }
  }

  return null;
}
