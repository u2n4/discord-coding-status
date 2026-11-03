'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface GrokResolvedModel {
  model: string;
  filePath: string;
  mtimeMs: number;
}

export function getGrokHomeDirectory(): string {
  const configured = (process.env.DISCORD_CODING_STATUS_GROK_HOME || process.env.GROK_HOME || '').trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), '.grok');
}

export function getGrokConfigFilePath(): string {
  return path.join(getGrokHomeDirectory(), 'config.toml');
}

const grokSummaryPathCache = new Map<string, string>();
const grokFileModelCache = new Map<string, { mtimeMs: number; model: string | null }>();

export function findGrokSessionSummaryFile(sessionId: string, cwd?: string | null): string | null {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId || normalizedSessionId.includes('/') || normalizedSessionId.includes('\\') || normalizedSessionId.includes('..')) {
    return null;
  }

  const cacheKey = `${getGrokHomeDirectory()}|${normalizedSessionId}`;
  const cachedPath = grokSummaryPathCache.get(cacheKey);
  if (cachedPath && fs.existsSync(cachedPath)) {
    return cachedPath;
  }

  const sessionsRoot = path.join(getGrokHomeDirectory(), 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    return null;
  }

  if (typeof cwd === 'string' && cwd.trim()) {
    const resolvedCwd = path.resolve(cwd.trim());
    const directCandidate = path.join(sessionsRoot, encodeURIComponent(resolvedCwd), normalizedSessionId, 'summary.json');
    if (fs.existsSync(directCandidate)) {
      grokSummaryPathCache.set(cacheKey, directCandidate);
      return directCandidate;
    }
  }

  try {
    const entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(sessionsRoot, entry.name, normalizedSessionId, 'summary.json');
      if (fs.existsSync(candidate)) {
        grokSummaryPathCache.set(cacheKey, candidate);
        return candidate;
      }
    }
  } catch (_) {
    return null;
  }

  return null;
}

export function readGrokSessionSummaryModel(sessionId: string, cwd?: string | null): GrokResolvedModel | null {
  const summaryFile = findGrokSessionSummaryFile(sessionId, cwd);
  if (!summaryFile) {
    return null;
  }

  try {
    const stat = fs.statSync(summaryFile);
    const cached = grokFileModelCache.get(summaryFile);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.model ? { model: cached.model, filePath: summaryFile, mtimeMs: stat.mtimeMs } : null;
    }
    const parsed = JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as Record<string, unknown>;
    const info = parsed?.info;
    const recordedId = info && typeof info === 'object' && !Array.isArray(info)
      ? (info as Record<string, unknown>).id
      : null;
    if (typeof recordedId === 'string' && recordedId.trim() !== sessionId.trim()) {
      grokFileModelCache.set(summaryFile, { mtimeMs: stat.mtimeMs, model: null });
      return null;
    }
    const model = parsed?.current_model_id;
    if (typeof model === 'string' && model.trim()) {
      const trimmed = model.trim();
      grokFileModelCache.set(summaryFile, { mtimeMs: stat.mtimeMs, model: trimmed });
      return {
        model: trimmed,
        filePath: summaryFile,
        mtimeMs: stat.mtimeMs
      };
    }
    grokFileModelCache.set(summaryFile, { mtimeMs: stat.mtimeMs, model: null });
  } catch (_) {
    return null;
  }

  return null;
}

// Grok Build records every open TUI in ~/.grok/active_sessions.json as
// { session_id, pid, cwd }, which binds a live grok.exe to its own session
// summary (current_model_id follows /model switches).
export function findGrokActiveSessionForPid(pid: number | null | undefined): { sessionId: string; cwd: string | null } | null {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(getGrokHomeDirectory(), 'active_sessions.json'), 'utf8'));
    const matches = (Array.isArray(parsed) ? parsed : []).filter((entry) => entry?.pid === pid
      && typeof entry?.session_id === 'string' && entry.session_id.trim());
    if (matches.length !== 1) {
      return null;
    }
    return {
      sessionId: matches[0].session_id.trim(),
      cwd: typeof matches[0].cwd === 'string' ? matches[0].cwd : null
    };
  } catch (_) {
    return null;
  }
}

export function readGrokProcessModel(pid: number | null | undefined): GrokResolvedModel | null {
  const session = findGrokActiveSessionForPid(pid);
  return session ? readGrokSessionSummaryModel(session.sessionId, session.cwd) : null;
}

export function parseGrokConfigTomlDefaultModel(content: string): string | null {
  const lines = content.split(/\r?\n/);
  let inModelsSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('[')) {
      inModelsSection = line.toLowerCase() === '[models]';
      continue;
    }
    if (!inModelsSection) {
      continue;
    }
    const match = line.match(/^default\s*=\s*(?:"([^"]+)"|'([^']+)')/);
    if (match) {
      const value = (match[1] ?? match[2] ?? '').trim();
      return value || null;
    }
  }

  return null;
}

export function readGrokDefaultConfigModel(): GrokResolvedModel | null {
  const configPath = getGrokConfigFilePath();
  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const stat = fs.statSync(configPath);
    const model = parseGrokConfigTomlDefaultModel(fs.readFileSync(configPath, 'utf8'));
    if (model && Number.isFinite(stat.mtimeMs)) {
      return {
        model,
        filePath: configPath,
        mtimeMs: stat.mtimeMs
      };
    }
  } catch (_) {
    return null;
  }
  return null;
}
