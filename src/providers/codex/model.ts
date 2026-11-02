'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CodexConfiguredModel {
  model: string;
  mtimeMs: number;
  filePath: string;
}

export function getCodexHomeDirectory(): string {
  const configured = process.env.CODEX_HOME?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), '.codex');
}

export function getCodexConfigFilePath(): string {
  return path.join(getCodexHomeDirectory(), 'config.toml');
}

export function getCodexGlobalStateFilePath(): string {
  return path.join(getCodexHomeDirectory(), '.codex-global-state.json');
}

export function parseCodexConfigTomlModel(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('[')) {
      // Top-level keys in TOML appear before the first table header.
      break;
    }
    const match = line.match(/^model\s*=\s*(?:"([^"]+)"|'([^']+)')/);
    if (match) {
      const value = (match[1] ?? match[2] ?? '').trim();
      return value || null;
    }
  }
  return null;
}

export function parseCodexGlobalStateModel(content: string): string | null {
  const recentMatch = content.match(
    /"composer-recent-model-configurations-v1"\s*:\s*\[\s*\{[^}\]]*?"model"\s*:\s*"([^"]+)"/
  );
  if (recentMatch?.[1]?.trim()) {
    return recentMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const atomState = parsed?.['electron-persisted-atom-state'];
    if (atomState && typeof atomState === 'object' && !Array.isArray(atomState)) {
      const recent = (atomState as Record<string, unknown>)['composer-recent-model-configurations-v1'];
      if (Array.isArray(recent) && recent.length > 0) {
        const first = recent[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) {
          const model = (first as Record<string, unknown>).model;
          if (typeof model === 'string' && model.trim()) {
            return model.trim();
          }
        }
      }
    }
    const workspaceState = parsed?.['electron-saved-workspace-state'];
    if (workspaceState && typeof workspaceState === 'object' && !Array.isArray(workspaceState)) {
      const wsRecord = workspaceState as Record<string, unknown>;
      const model = wsRecord.model || wsRecord.defaultModel;
      if (typeof model === 'string' && model.trim()) {
        return model.trim();
      }
    }
  } catch (_) {
    return null;
  }
  return null;
}

interface CachedCodexModelEntry {
  statMtimeMs: number;
  model: string | null;
  modelChangedAtMs: number;
}

const codexModelCache = new Map<string, CachedCodexModelEntry>();

function readCachedCodexModelFile(
  filePath: string,
  parser: (content: string) => string | null
): CodexConfiguredModel | null {
  try {
    if (!fs.existsSync(filePath)) {
      codexModelCache.delete(filePath);
      return null;
    }
    const stat = fs.statSync(filePath);
    if (!Number.isFinite(stat.mtimeMs)) {
      return null;
    }
    const prev = codexModelCache.get(filePath);
    if (prev && prev.statMtimeMs === stat.mtimeMs) {
      return prev.model
        ? { model: prev.model, mtimeMs: prev.modelChangedAtMs, filePath }
        : null;
    }
    const model = parser(fs.readFileSync(filePath, 'utf8'));
    const modelChangedAtMs =
      prev && prev.model === model ? prev.modelChangedAtMs : stat.mtimeMs;
    codexModelCache.set(filePath, {
      statMtimeMs: stat.mtimeMs,
      model,
      modelChangedAtMs
    });
    return model ? { model, mtimeMs: modelChangedAtMs, filePath } : null;
  } catch (_) {
    return null;
  }
}

// Codex CLI: the top-level `model` in config.toml is the persisted default
// (`/model` writes it). The Desktop composer state is never consulted for the
// CLI, because it records Desktop picks, not the CLI session.
export function readCodexConfiguredModel(): CodexConfiguredModel | null {
  return readCachedCodexModelFile(getCodexConfigFilePath(), parseCodexConfigTomlModel);
}

// Codex Desktop: the most recent composer pick in .codex-global-state.json.
export function readCodexDesktopModel(): CodexConfiguredModel | null {
  return readCachedCodexModelFile(getCodexGlobalStateFilePath(), parseCodexGlobalStateModel);
}
