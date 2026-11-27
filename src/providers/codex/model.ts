'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CodexConfiguredModel {
  model: string;
  effort?: string | null;
  mtimeMs: number;
  effortChangedAtMs?: number;
  filePath: string;
  /** When this process saw the model value itself change (0 = never seen changing). */
  observedChangeAtMs: number;
  /** When this process saw the effort value itself change (0 = never seen changing). */
  observedEffortChangeAtMs?: number;
}

export interface CodexParsedSelection {
  model: string | null;
  effort: string | null;
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

export function getCodexGlobalStateSqliteFilePath(): string {
  return path.join(getCodexHomeDirectory(), '.codex-global-state.sqlite');
}

export function parseCodexConfigToml(content: string): CodexParsedSelection {
  let model: string | null = null;
  let effort: string | null = null;
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
    if (model === null) {
      const modelMatch = line.match(/^model\s*=\s*(?:"([^"]+)"|'([^']+)')/);
      if (modelMatch) {
        const value = (modelMatch[1] ?? modelMatch[2] ?? '').trim();
        if (value) {
          model = value;
        }
      }
    }
    if (effort === null) {
      const effortMatch = line.match(/^model_reasoning_effort\s*=\s*(?:"([^"]+)"|'([^']+)')/);
      if (effortMatch) {
        const value = (effortMatch[1] ?? effortMatch[2] ?? '').trim();
        if (value) {
          effort = value;
        }
      }
    }
  }
  return { model, effort };
}

export function parseCodexConfigTomlModel(content: string): string | null {
  return parseCodexConfigToml(content).model;
}

function readRecentConfigEntry(container: unknown): CodexParsedSelection | null {
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    return null;
  }
  const recent = (container as Record<string, unknown>)['composer-recent-model-configurations-v1'];
  if (!Array.isArray(recent) || recent.length === 0) {
    return null;
  }
  const first = recent[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return null;
  }
  const record = first as Record<string, unknown>;
  const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : null;
  const effort = typeof record.reasoningEffort === 'string' && record.reasoningEffort.trim()
    ? record.reasoningEffort.trim()
    : (typeof record.reasoning_effort === 'string' && record.reasoning_effort.trim()
      ? record.reasoning_effort.trim()
      : (typeof record.effort === 'string' && record.effort.trim() ? record.effort.trim() : null));
  return model ? { model, effort } : null;
}

export function parseCodexGlobalState(content: string): CodexParsedSelection {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    // Prefer the active account's owner-scoped atoms (current Codex Desktop),
    // then legacy electron-persisted-atom-state, then any owner atom block.
    const activeOwner = typeof parsed?.['electron-renderer-content-owner'] === 'string'
      ? parsed['electron-renderer-content-owner'].trim()
      : '';
    if (activeOwner) {
      const owned = readRecentConfigEntry(parsed[`electron-owner-atoms:${activeOwner}`]);
      if (owned) {
        return owned;
      }
    }
    const persisted = readRecentConfigEntry(parsed?.['electron-persisted-atom-state']);
    if (persisted) {
      return persisted;
    }
    for (const [key, value] of Object.entries(parsed || {})) {
      if (key.startsWith('electron-owner-atoms:')) {
        const entry = readRecentConfigEntry(value);
        if (entry) {
          return entry;
        }
      }
    }
    const workspaceState = parsed?.['electron-saved-workspace-state'];
    if (workspaceState && typeof workspaceState === 'object' && !Array.isArray(workspaceState)) {
      const wsRecord = workspaceState as Record<string, unknown>;
      const model = wsRecord.model || wsRecord.defaultModel;
      const effort = wsRecord.reasoningEffort || wsRecord.reasoning_effort || wsRecord.effort;
      if (typeof model === 'string' && model.trim()) {
        return {
          model: model.trim(),
          effort: typeof effort === 'string' && effort.trim() ? effort.trim() : null
        };
      }
    }
  } catch (_) {
    // Fall through to lightweight regex fallback for partially written JSON.
  }

  const blockMatch = content.match(
    /"composer-recent-model-configurations-v1"\s*:\s*\[\s*(\{[^}\]]*\})/
  );
  if (blockMatch?.[1]) {
    const modelMatch = blockMatch[1].match(/"model"\s*:\s*"([^"]+)"/);
    const effortMatch = blockMatch[1].match(/"(?:reasoningEffort|reasoning_effort|effort)"\s*:\s*"([^"]+)"/);
    if (modelMatch?.[1]?.trim()) {
      return {
        model: modelMatch[1].trim(),
        effort: effortMatch?.[1]?.trim() || null
      };
    }
  }
  return { model: null, effort: null };
}

export function parseCodexGlobalStateModel(content: string): string | null {
  return parseCodexGlobalState(content).model;
}

interface CachedCodexModelEntry {
  statMtimeMs: number;
  model: string | null;
  effort: string | null;
  modelChangedAtMs: number;
  effortChangedAtMs: number;
  observedChangeAtMs: number;
  observedEffortChangeAtMs: number;
}

const codexModelCache = new Map<string, CachedCodexModelEntry>();

function readCachedCodexModelFile(
  filePath: string,
  parser: (content: string) => CodexParsedSelection
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
        ? {
          model: prev.model,
          effort: prev.effort,
          mtimeMs: prev.modelChangedAtMs,
          effortChangedAtMs: prev.effortChangedAtMs,
          filePath,
          observedChangeAtMs: prev.observedChangeAtMs,
          observedEffortChangeAtMs: prev.observedEffortChangeAtMs
        }
        : null;
    }
    const { model, effort } = parser(fs.readFileSync(filePath, 'utf8'));
    const modelChangedAtMs =
      prev && prev.model === model ? prev.modelChangedAtMs : stat.mtimeMs;
    const effortChangedAtMs =
      prev && prev.effort === effort ? prev.effortChangedAtMs : stat.mtimeMs;
    // Other config.toml writes (trust entries, MCP edits) move the mtime too,
    // so only a value change seen between two reads counts as a /model or /effort switch.
    const observedChangeAtMs = prev
      ? (prev.model === model ? prev.observedChangeAtMs : stat.mtimeMs)
      : 0;
    const observedEffortChangeAtMs = prev
      ? (prev.effort === effort ? prev.observedEffortChangeAtMs : stat.mtimeMs)
      : 0;
    codexModelCache.set(filePath, {
      statMtimeMs: stat.mtimeMs,
      model,
      effort,
      modelChangedAtMs,
      effortChangedAtMs,
      observedChangeAtMs,
      observedEffortChangeAtMs
    });
    return model
      ? {
        model,
        effort,
        mtimeMs: modelChangedAtMs,
        effortChangedAtMs,
        filePath,
        observedChangeAtMs,
        observedEffortChangeAtMs
      }
      : null;
  } catch (_) {
    return null;
  }
}

// Codex CLI: the top-level `model` and `model_reasoning_effort` in config.toml
// are the persisted defaults (`/model` writes them). The Desktop composer state
// is never consulted for the CLI, because it records Desktop picks, not the CLI session.
export function readCodexConfiguredModel(): CodexConfiguredModel | null {
  return readCachedCodexModelFile(getCodexConfigFilePath(), parseCodexConfigToml);
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
// `-m x`, `-c model=x`) or effort (`-c model_reasoning_effort=xhigh`,
// `--effort max`) runs those overrides regardless of config.toml.
export function parseCodexCommandLine(commandLine: string | null | undefined): CodexParsedSelection {
  if (typeof commandLine !== 'string' || !commandLine.trim()) {
    return { model: null, effort: null };
  }
  const tokens = splitWindowsCommandLine(commandLine);
  const unquote = (token: string | undefined) => (token || '').replace(/^(["'])(.*)\1$/, '$2').trim();
  let model: string | null = null;
  let effort: string | null = null;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = unquote(tokens[index]);
    let modelValue: string | null = null;
    let effortValue: string | null = null;
    if (token === '--model' || token === '-m') {
      modelValue = unquote(tokens[index + 1]);
      index += 1;
    } else if (token.startsWith('--model=')) {
      modelValue = token.slice('--model='.length);
    } else if (token === '--effort' || token === '--reasoning-effort') {
      effortValue = unquote(tokens[index + 1]);
      index += 1;
    } else if (token.startsWith('--effort=')) {
      effortValue = token.slice('--effort='.length);
    } else if (token.startsWith('--reasoning-effort=')) {
      effortValue = token.slice('--reasoning-effort='.length);
    } else if (token === '-c' || token === '--config') {
      const next = unquote(tokens[index + 1]);
      index += 1;
      const modelOverride = next.match(/^model\s*=\s*(.+)$/);
      const effortOverride = next.match(/^model_reasoning_effort\s*=\s*(.+)$/);
      modelValue = modelOverride ? unquote(modelOverride[1]) : null;
      effortValue = effortOverride ? unquote(effortOverride[1]) : null;
    } else if (token.startsWith('--config=')) {
      const rest = token.slice('--config='.length);
      const modelOverride = rest.match(/^model\s*=\s*(.+)$/);
      const effortOverride = rest.match(/^model_reasoning_effort\s*=\s*(.+)$/);
      modelValue = modelOverride ? unquote(modelOverride[1]) : null;
      effortValue = effortOverride ? unquote(effortOverride[1]) : null;
    }
    if (modelValue && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,80}$/.test(modelValue)) {
      // The last flag wins, as in Codex's own argument parsing.
      model = modelValue;
    }
    if (effortValue && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,30}$/.test(effortValue)) {
      effort = effortValue;
    }
  }
  return { model, effort };
}

export function parseCodexCommandLineModel(commandLine: string | null | undefined): string | null {
  return parseCodexCommandLine(commandLine).model;
}

type SqliteModule = { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => any };
let codexSqliteModule: SqliteModule | null | undefined;

function loadCodexSqlite(): SqliteModule | null {
  if (codexSqliteModule === undefined) {
    try {
      const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
      codexSqliteModule = (typeof getBuiltin === 'function' ? getBuiltin.call(process, 'node:sqlite') as SqliteModule : null) || null;
    } catch (_) {
      codexSqliteModule = null;
    }
  }
  return codexSqliteModule;
}

interface CachedCodexSqliteEntry {
  signature: string;
  model: string | null;
  effort: string | null;
  modelChangedAtMs: number;
  effortChangedAtMs: number;
  observedChangeAtMs: number;
  observedEffortChangeAtMs: number;
}

const codexSqliteCache = new Map<string, CachedCodexSqliteEntry>();

function sqliteFileStamp(filePath: string): { signature: string; mtimeMs: number } | null {
  try {
    const main = fs.statSync(filePath);
    if (!Number.isFinite(main.mtimeMs)) {
      return null;
    }
    let mtimeMs = main.mtimeMs;
    let walPart = '';
    try {
      const wal = fs.statSync(`${filePath}-wal`);
      if (Number.isFinite(wal.mtimeMs)) {
        mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
        walPart = `${wal.mtimeMs}:${wal.size}`;
      }
    } catch (_) {}
    return { signature: `${main.mtimeMs}:${main.size}|${walPart}`, mtimeMs };
  } catch (_) {
    return null;
  }
}

function parseRecentConfigArrayJson(raw: unknown): CodexParsedSelection | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return readRecentConfigEntry({ 'composer-recent-model-configurations-v1': parsed });
  } catch (_) {
    return null;
  }
}

export function readCodexGlobalStateSqlite(
  filePath: string = getCodexGlobalStateSqliteFilePath()
): CodexConfiguredModel | null {
  const stamp = sqliteFileStamp(filePath);
  if (!stamp) {
    codexSqliteCache.delete(filePath);
    return null;
  }
  const prev = codexSqliteCache.get(filePath);
  if (prev && prev.signature === stamp.signature) {
    return prev.model
      ? {
        model: prev.model,
        effort: prev.effort,
        mtimeMs: prev.modelChangedAtMs,
        effortChangedAtMs: prev.effortChangedAtMs,
        filePath,
        observedChangeAtMs: prev.observedChangeAtMs,
        observedEffortChangeAtMs: prev.observedEffortChangeAtMs
      }
      : null;
  }

  const sqlite = loadCodexSqlite();
  if (!sqlite) {
    return null;
  }
  let db: any = null;
  let selection: CodexParsedSelection | null = null;
  try {
    db = new sqlite.DatabaseSync(filePath, { readOnly: true });
    const ownerRow = db.prepare(
      "SELECT value FROM settings WHERE scope = 'global' AND key = 'electron-renderer-content-owner' LIMIT 1"
    ).get() as { value?: unknown } | undefined;
    let owner = '';
    if (typeof ownerRow?.value === 'string' && ownerRow.value.trim()) {
      try {
        const decoded = JSON.parse(ownerRow.value);
        if (typeof decoded === 'string') {
          owner = decoded.trim();
        }
      } catch (_) {
        owner = ownerRow.value.trim().replace(/^"(.*)"$/, '$1');
      }
    }
    if (owner) {
      const ownedRow = db.prepare(
        "SELECT value FROM settings WHERE scope = ? AND key = 'composer-recent-model-configurations-v1' LIMIT 1"
      ).get(`electron-owner-atoms:${owner}`) as { value?: unknown } | undefined;
      selection = parseRecentConfigArrayJson(ownedRow?.value);
    }
    if (!selection) {
      const anyRow = db.prepare(
        "SELECT value FROM settings WHERE key = 'composer-recent-model-configurations-v1' LIMIT 1"
      ).get() as { value?: unknown } | undefined;
      selection = parseRecentConfigArrayJson(anyRow?.value);
    }
  } catch (_) {
    return null;
  } finally {
    try {
      db?.close();
    } catch (_) {}
  }

  const model = selection?.model || null;
  const effort = selection?.effort || null;
  const modelChangedAtMs = prev && prev.model === model ? prev.modelChangedAtMs : stamp.mtimeMs;
  const effortChangedAtMs = prev && prev.effort === effort ? prev.effortChangedAtMs : stamp.mtimeMs;
  const observedChangeAtMs = prev
    ? (prev.model === model ? prev.observedChangeAtMs : stamp.mtimeMs)
    : 0;
  const observedEffortChangeAtMs = prev
    ? (prev.effort === effort ? prev.observedEffortChangeAtMs : stamp.mtimeMs)
    : 0;

  codexSqliteCache.set(filePath, {
    signature: stamp.signature,
    model,
    effort,
    modelChangedAtMs,
    effortChangedAtMs,
    observedChangeAtMs,
    observedEffortChangeAtMs
  });

  return model
    ? {
      model,
      effort,
      mtimeMs: modelChangedAtMs,
      effortChangedAtMs,
      filePath,
      observedChangeAtMs,
      observedEffortChangeAtMs
    }
    : null;
}

// Codex Desktop: current builds store state in .codex-global-state.sqlite and
// write the live composer picker's model + model_reasoning_effort directly to
// config.toml on every dropdown change (while composer-recent-model-configurations-v1
// only updates when a turn is submitted). Legacy builds without the SQLite
// store keep reading .codex-global-state.json directly.
export function readCodexDesktopModel(): CodexConfiguredModel | null {
  const sqliteFile = getCodexGlobalStateSqliteFilePath();
  if (fs.existsSync(sqliteFile)) {
    const sqliteState = readCodexGlobalStateSqlite(sqliteFile);
    const configured = readCodexConfiguredModel();
    if (configured?.model) {
      const sqliteModelNewer = Boolean(
        sqliteState?.model
        && sqliteState.observedChangeAtMs > 0
        && sqliteState.observedChangeAtMs > configured.mtimeMs
      );
      const sqliteEffortNewer = Boolean(
        sqliteState?.model
        && (sqliteState.observedEffortChangeAtMs || 0) > 0
        && (sqliteState.observedEffortChangeAtMs || 0) > (configured.effortChangedAtMs || configured.mtimeMs)
      );
      if (sqliteModelNewer || sqliteEffortNewer) {
        return sqliteState;
      }
      return configured;
    }
    if (sqliteState?.model) {
      return sqliteState;
    }
  }
  return readCachedCodexModelFile(getCodexGlobalStateFilePath(), parseCodexGlobalState);
}
