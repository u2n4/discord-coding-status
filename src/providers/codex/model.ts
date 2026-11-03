'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CodexConfiguredModel {
  model: string;
  mtimeMs: number;
  filePath: string;
  /** When this process saw the model value itself change (0 = never seen changing). */
  observedChangeAtMs: number;
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
  observedChangeAtMs: number;
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
        ? { model: prev.model, mtimeMs: prev.modelChangedAtMs, filePath, observedChangeAtMs: prev.observedChangeAtMs }
        : null;
    }
    const model = parser(fs.readFileSync(filePath, 'utf8'));
    const modelChangedAtMs =
      prev && prev.model === model ? prev.modelChangedAtMs : stat.mtimeMs;
    // Other config.toml writes (trust entries, MCP edits) move the mtime too,
    // so only a value change seen between two reads counts as a /model switch.
    const observedChangeAtMs = prev
      ? (prev.model === model ? prev.observedChangeAtMs : stat.mtimeMs)
      : 0;
    codexModelCache.set(filePath, {
      statMtimeMs: stat.mtimeMs,
      model,
      modelChangedAtMs,
      observedChangeAtMs
    });
    return model ? { model, mtimeMs: modelChangedAtMs, filePath, observedChangeAtMs } : null;
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

// CommandLineToArgvW rules: quotes group, \" is a literal quote, and 2n
// backslashes before a quote become n.
export function splitWindowsCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let inQuotes = false;
  for (let index = 0; index < commandLine.length; index += 1) {
    const ch = commandLine[index];
    if (ch === '\\') {
      let slashes = 0;
      while (commandLine[index] === '\\') {
        slashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        current += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          current += '"';
        } else {
          inQuotes = !inQuotes;
        }
      } else {
        current += '\\'.repeat(slashes);
        index -= 1;
      }
      inToken = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      inToken = true;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

// Codex CLI launched with an explicit model (`codex --model gpt-6.2-astra`,
// `-m x`, `-c model=x`) runs that model regardless of config.toml, so the
// flag on the live process outranks the persisted default.
export function parseCodexCommandLineModel(commandLine: string | null | undefined): string | null {
  if (typeof commandLine !== 'string' || !commandLine.trim()) {
    return null;
  }
  const tokens = splitWindowsCommandLine(commandLine);
  const unquote = (token: string | undefined) => (token || '').replace(/^(["'])(.*)\1$/, '$2').trim();
  let model: string | null = null;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = unquote(tokens[index]);
    let value: string | null = null;
    if (token === '--model' || token === '-m') {
      value = unquote(tokens[index + 1]);
      index += 1;
    } else if (token.startsWith('--model=')) {
      value = token.slice('--model='.length);
    } else if (token === '-c' || token === '--config') {
      const override = unquote(tokens[index + 1]).match(/^model\s*=\s*(.+)$/);
      index += 1;
      value = override ? unquote(override[1]) : null;
    } else if (token.startsWith('--config=')) {
      const override = token.slice('--config='.length).match(/^model\s*=\s*(.+)$/);
      value = override ? unquote(override[1]) : null;
    }
    if (value && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,80}$/.test(value)) {
      // The last flag wins, as in Codex's own argument parsing.
      model = value;
    }
  }
  return model;
}

// Codex Desktop: the most recent composer pick in .codex-global-state.json.
export function readCodexDesktopModel(): CodexConfiguredModel | null {
  return readCachedCodexModelFile(getCodexGlobalStateFilePath(), parseCodexGlobalStateModel);
}
