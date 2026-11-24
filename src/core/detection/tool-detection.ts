'use strict';

import * as path from 'node:path';

export interface ProcessDescriptor {
  line: string;
  executablePath?: string | null;
  commandLine?: string | null;
}

export interface WindowsStartApp {
  name: string;
  appId: string;
}

function processText(value: ProcessDescriptor | string): string {
  if (typeof value === 'string') {
    return value;
  }

  return [value.executablePath, value.commandLine, value.line]
    .filter(Boolean)
    .join(' ');
}

function normalizedProcessText(value: ProcessDescriptor | string): string {
  return processText(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function executableBasename(value: ProcessDescriptor | string): string {
  if (typeof value !== 'string' && value.executablePath) {
    const normalized = value.executablePath.replace(/\\/g, '/');
    return path.posix.basename(normalized).toLowerCase();
  }

  const text = normalizedProcessText(value);
  const quoted = text.match(/^"([^"]+)"/);
  const executable = quoted?.[1] || text.match(/^(\S+)/)?.[1] || '';
  return path.posix.basename(executable.replace(/\\/g, '/')).toLowerCase();
}

export function parseWindowsStartApps(output: string): WindowsStartApp[] {
  const text = output.trim();
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (_) {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return [];
    }

    const record = row as Record<string, unknown>;
    const name = typeof record.Name === 'string' ? record.Name.trim() : '';
    const appId = typeof record.AppID === 'string' ? record.AppID.trim() : '';
    return name && appId ? [{ name, appId }] : [];
  });
}

export function windowsDesktopAppDetail(app: WindowsStartApp | null): string | null {
  return app ? `shell:AppsFolder\\${app.appId}` : null;
}

export function isClaudeCodeUrlHandlerProcess(value: ProcessDescriptor | string): boolean {
  const text = normalizedProcessText(value);
  return text.includes('claude code url handler')
    || text.includes('com.anthropic.claude-code-url-handler');
}

export function isClaudeDesktopProcess(value: ProcessDescriptor | string): boolean {
  const text = normalizedProcessText(value).replace(/\\/g, '/');
  if (isClaudeCodeUrlHandlerProcess(value)) {
    return false;
  }

  const isClaudeExecutable = /(?:^|[\s/])claude(?:\.exe)?(?:\s|$)/.test(text);
  const isKnownWindowsInstall = text.includes('/windowsapps/')
    || text.includes('/program files/claude/')
    || text.includes('/appdata/local/anthropicclaude/')
    || text.includes('/appdata/local/programs/claude/')
    || text.includes('/appdata/local/claude/');
  return text.includes('/claude.app/contents/')
    || (isKnownWindowsInstall && isClaudeExecutable);
}

const JS_WRAPPER_EXECUTABLES = /^(?:node|bun|bunx|npx|npm|pnpm|yarn)(?:\.(?:exe|cmd|bat))?$/;

function matchesJsRuntimeWrapper(
  value: ProcessDescriptor | string,
  executable: string,
  packageRegex: RegExp
): boolean {
  if (!JS_WRAPPER_EXECUTABLES.test(executable)) {
    return false;
  }

  const commandText = typeof value !== 'string' && value.commandLine
    ? value.commandLine.trim().toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ')
    : normalizedProcessText(value).replace(/\\/g, '/');

  // Inline evaluation (`node -e`, `bun --eval`, etc.) executes snippet code
  // such as MCP server loaders that often mention `~/.codex/...`, never an
  // interactive agent CLI entrypoint.
  if (/(?:^|\s)(?:-e|--eval)(?:\s|=|"|'|$)/.test(commandText)) {
    return false;
  }

  return packageRegex.test(commandText);
}

export function isClaudeCodeProcess(value: ProcessDescriptor | string): boolean {
  if (isClaudeDesktopProcess(value) || isClaudeCodeUrlHandlerProcess(value)) {
    return false;
  }

  const text = normalizedProcessText(value).replace(/\\/g, '/');
  const executable = executableBasename(value);
  return executable === 'claude'
    || executable === 'claude.exe'
    || executable === 'claude-code'
    || executable === 'claude-code.exe'
    || /(?:^|[\s/])claude-code(?:\.exe)?(?:\s|$)/.test(text)
    || matchesJsRuntimeWrapper(
      value,
      executable,
      /(?:^|[\s/"'])(?:@[\w.-]+\/)?claude-code(?:\/[^\s"']*)?(?:["'\s]|$)/
    );
}

export function isCodexDesktopProcess(value: ProcessDescriptor | string): boolean {
  const text = normalizedProcessText(value).replace(/\\/g, '/');
  if (text.includes('/codex.app/')) {
    return true;
  }

  if (text.includes('/chatgpt.app/')) {
    return text.includes('/contents/macos/chatgpt')
      || text.includes('/frameworks/codex framework.framework/')
      || text.includes('/contents/resources/codex') && /(?:^|\s)app-server(?:\s|$)/.test(text);
  }

  // ChatGPT Classic (OpenAI.ChatGPT-Desktop, "ChatGPT Classic.exe") is a plain
  // chat client without Codex. It must never light up as Codex presence.
  if (text.includes('chatgpt classic') || text.includes('openai.chatgpt-desktop')) {
    return false;
  }

  const isWindowsStoreApp = text.includes('/windowsapps/') && (
    // Exact "chatgpt.exe" basename: "ChatGPT Classic.exe" carries no contiguous
    // "chatgpt.exe" token, so it cannot match here either.
    /(?:^|[\s/])chatgpt\.exe(?:\s|$)/.test(text)
      || (text.includes('chatgpt')
        && /(?:^|[\s/])codex(?:\.exe)?(?:\s|$)/.test(text)
        && /(?:^|\s)app-server(?:\s|$)/.test(text))
  );
  const isUnpackagedWindowsHost = /(?:^|[\s/])chatgpt\.exe(?:\s|$)/.test(text);
  const isUnpackagedWindowsAppServer = text.includes('/chatgpt/')
      && /(?:^|[\s/])codex(?:\.exe)?(?:\s|$)/.test(text)
      && /(?:^|\s)app-server(?:\s|$)/.test(text);

  return isWindowsStoreApp || isUnpackagedWindowsHost || isUnpackagedWindowsAppServer;
}

export function isCodexCliProcess(value: ProcessDescriptor | string): boolean {
  if (isCodexDesktopProcess(value)) {
    return false;
  }

  const text = normalizedProcessText(value).replace(/\\/g, '/');
  const executable = executableBasename(value);

  // Exclude headless `codex app-server` / `codex exec-server` regardless of
  // whether launched natively or via a `node .../codex.js app-server` wrapper.
  if (/(?:^|\s)(?:app|exec)[-_]server(?:\s|$)/.test(text)) {
    return false;
  }

  if (executable === 'codex' || executable === 'codex.exe') {
    return true;
  }

  return matchesJsRuntimeWrapper(
    value,
    executable,
    /(?:^|[\s/"'])(?:@[\w.-]+\/)?codex(?:\/[^\s"']*)?(?:["'\s]|$)/
  );
}

export function isOpencodeProcess(value: ProcessDescriptor | string): boolean {
  const text = normalizedProcessText(value).replace(/\\/g, '/');
  const executable = executableBasename(value);

  // `opencode serve` is a headless server and `opencode acp` a protocol server.
  // Both stay resident for hours without anyone coding in them, so they must not
  // light up as active presence while the user works in another tool.
  if (/(?:^|[\s/])opencode(?:\.exe)?\s+(?:serve|acp)(?:\s|$)/.test(text)) {
    return false;
  }

  return executable === 'opencode'
    || executable === 'opencode.exe'
    || matchesJsRuntimeWrapper(
      value,
      executable,
      /(?:^|[\s/"'])(?:@[\w.-]+\/)?opencode(?:\/[^\s"']*)?(?:["'\s]|$)/
    );
}

export function isPiProcess(value: ProcessDescriptor | string): boolean {
  const executable = executableBasename(value);
  return executable === 'pi'
    || executable === 'pi.exe'
    || matchesJsRuntimeWrapper(
      value,
      executable,
      /(?:^|[\s/"'])(?:@[\w.-]+\/)?pi-coding-agent(?:\/[^\s"']*)?(?:["'\s]|$)/
    );
}

export function isGrokProcess(value: ProcessDescriptor | string): boolean {
  const executable = executableBasename(value);
  return executable === 'grok'
    || executable === 'grok.exe'
    || matchesJsRuntimeWrapper(
      value,
      executable,
      /(?:^|[\s/"'])(?:@[\w.-]+\/)?grok(?:\/[^\s"']*)?(?:["'\s]|$)/
    );
}

const T3_CODE_EXECUTABLE_REGEX = /^(?:t3 code(?: \([a-z0-9._ -]+\))?\.exe|t3code(?:\.exe)?|t3-code)$/;
const T3_CODE_MAC_BUNDLE_REGEX = /\/(?:t3 code(?: \([a-z0-9._ -]+\))?|t3code)\.app\/contents\//;

// The desktop app, including channel builds (`T3 Code (Beta).exe`,
// `T3 Code (Nightly).exe`, etc.). Uninstallers, the resource monitor, and a
// folder that merely contains "t3code" are not the app.
export function isT3CodeProcess(value: ProcessDescriptor | string): boolean {
  const executable = executableBasename(value);
  if (T3_CODE_EXECUTABLE_REGEX.test(executable)) {
    return true;
  }
  const text = normalizedProcessText(value).replace(/\\/g, '/');
  return T3_CODE_MAC_BUNDLE_REGEX.test(text);
}

export function isT3NightlyProcess(value: ProcessDescriptor | string): boolean {
  const executable = executableBasename(value);
  if (executable === 't3 code (nightly).exe') {
    return true;
  }
  const text = normalizedProcessText(value).replace(/\\/g, '/');
  return text.includes('/t3 code (nightly).app/contents/');
}

export function isCursorProcess(value: ProcessDescriptor | string): boolean {
  const text = normalizedProcessText(value).replace(/\\/g, '/');
  const executable = executableBasename(value);

  if (executable === 'cursor' || executable === 'cursor.exe') {
    return true;
  }

  return text.includes('/cursor.app/')
    || text.includes('cursor')
      && /(?:^|[\s/])(?:cursor)(?:[/.][^\s]*)?(?:\s|$)/.test(text);
}

/**
 * Exact Muse binary basename match (no command-line guessing): the `muse`
 * launcher plus versioned `muse-bin-*` executables. Decoys such as
 * `amuse.exe` or `museum` never match.
 */
export function isMuseBinaryBasename(value: string): boolean {
  const basename = value.trim().toLowerCase();
  return basename === 'muse'
    || basename === 'muse.exe'
    || /^muse-bin-[\w.+-]+(?:\.exe)?$/.test(basename);
}

export function isMuseProcess(value: ProcessDescriptor | string): boolean {
  const text = normalizedProcessText(value).replace(/\\/g, '/');
  const executable = executableBasename(value);

  if (executable === 'muse'
    || executable === 'muse.exe'
    || /^muse-bin-[\w.+-]+(?:\.exe)?$/.test(executable)) {
    return true;
  }

  return /(?:^|[\s/])muse-bin-[\w.+-]+(?:\.exe)?(?:\s|$)/.test(text)
    || /(?:^|[\s/])muse(?:\.exe|\.cmd)?(?:\s|$)/.test(text);
}

export function isAntigravityProcess(value: ProcessDescriptor | string): boolean {
  const text = normalizedProcessText(value).replace(/\\/g, '/');
  if (
    /(?:^|\s)--type=(?:gpu-process|utility|renderer|crashpad-handler|zygote)(?:\s|$)/.test(text)
    || text.includes('--import=')
    || text.includes('--ms-enable-electron-run-as-node')
    || text.includes('sidecar')
    || text.includes('bootstrap-fork')
    || /\.(?:cjs|mjs|js)(?:\s|"|$)/.test(text)
  ) {
    return false;
  }

  const executable = executableBasename(value);
  if (executable === 'antigravity' || executable === 'antigravity.exe') {
    return true;
  }

  return text.includes('/antigravity.app/contents/macos/antigravity')
    || (text.includes('/antigravity/') && /(?:^|[\s/])antigravity(?:\.exe)?(?:\s|$)/.test(text));
}

// Antigravity CLI (`agy`), a separate binary from the Antigravity desktop app.
// `agy acp` is a headless ACP protocol server (for example spawned by T3 Code),
// not an interactive terminal CLI, so it must not light up as Antigravity.
export function isAntigravityCliProcess(value: ProcessDescriptor | string): boolean {
  const executable = executableBasename(value);
  if (executable !== 'agy' && executable !== 'agy.exe') {
    return false;
  }
  const text = normalizedProcessText(value).replace(/\\/g, '/');
  if (/(?:^|[\s/"'])agy(?:\.exe)?["']?\s+acp(?:\s|$)/.test(text)) {
    return false;
  }
  return true;
}
