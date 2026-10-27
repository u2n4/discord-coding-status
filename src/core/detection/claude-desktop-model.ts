'use strict';

// Pure selector for the Claude Desktop Code selected-model button (Windows UI
// Automation). No I/O, no subprocesses: the adapter helper queries the live
// window and feeds candidates here; unit tests feed fixtures directly.
//
// Authoritative native-UI proof (Main, this machine; example values, NEVER
// hardcoded as production constants): Claude Desktop Code mode, new session,
// model button CONTROLTYPE Button with exact Name "Model: Opus 5.5 Extra".
// Its FIRST child text label "Opus 5.5" is the MODEL; the later "Extra" child
// is separate EFFORT and must be omitted. The model menu carries the same
// Name but CONTROLTYPE Menu and must never be read as the button. The button
// lives inside the embedded web document, not the native outer title bar;
// menu choices observed: Opus 5.5 / Fable 5.1 / Sonnet 5.5 / Haiku 5.5. No
// AutomationId/HelpText is exposed and React base-ui IDs are dynamic, so the
// selector is Button-only plus an exact "Model:" name prefix plus the FIRST
// text child. Display is the exact child label ("Model: Opus 5.5"); never map
// it to a guessed claude-opus-* ID and never append effort.
//
// Supported managed UIA entry points (Manager-checked Microsoft docs):
// - AutomationElement.FromHandle/FindFirst(TreeScope, Condition):
//   https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.findfirst
// - Managed PropertyConditionFlags is ONLY None(0)/IgnoreCase(1); there is no
//   managed MatchSubstring flag, so prefix matching is done client-side via
//   StartsWith after a Button-only FindAll (narrow: Buttons with the prefix
//   only; non-matching Names are discarded without copying or logging):
//   https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.propertyconditionflags
// - Native PropertyConditionFlags_MatchSubstring(0x2) exists on Win10 1809+
//   but needs a native COM interface (IUIAutomation); not used here:
//   https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/ne-uiautomationclient-propertyconditionflags
//
// Binding and privacy contract: a model is returned ONLY for exactly one
// Button candidate whose PID and HWND both equal the positively bound CURRENT
// Claude foreground window/process/package (verified by the caller via the
// process snapshot and GetForegroundWindow). Wrong PID, wrong HWND, Menu (or
// any non-Button) control type, missing/empty first child, zero matches, or
// several matches all fail closed to null (application name only). Only the
// model button Name prefix and its FIRST text child are ever read; no
// conversation, project, or general UI text is captured, copied, or logged.

export const CLAUDE_DESKTOP_MODEL_BUTTON_PREFIX = 'Model:';
export const CLAUDE_DESKTOP_CONTROL_TYPE_BUTTON = 'Button';
export const CLAUDE_DESKTOP_CONTROL_TYPE_MENU = 'Menu';
export const CLAUDE_DESKTOP_MODEL_LABEL_MAX_LENGTH = 128;

export interface ClaudeDesktopUiCandidate {
  pid: number;
  hwnd: number;
  controlType: string;
  name: string;
  modelChildLabel: string | null;
}

export interface ClaudeDesktopModelBinding {
  pid: number;
  hwnd: number;
}

export function isClaudeDesktopModelButtonName(name: unknown): boolean {
  if (typeof name !== 'string') {
    return false;
  }

  const trimmed = name.trim();
  return trimmed.length > CLAUDE_DESKTOP_MODEL_BUTTON_PREFIX.length
    && trimmed.startsWith(CLAUDE_DESKTOP_MODEL_BUTTON_PREFIX);
}

export function parseClaudeDesktopModelChildLabel(
  buttonName: unknown,
  firstChildLabel: unknown
): string | null {
  if (!isClaudeDesktopModelButtonName(buttonName)) {
    return null;
  }

  if (typeof firstChildLabel !== 'string') {
    return null;
  }

  const label = firstChildLabel.trim();
  if (!label || label.length > CLAUDE_DESKTOP_MODEL_LABEL_MAX_LENGTH) {
    return null;
  }

  return label;
}

export function selectClaudeDesktopModel(
  candidates: readonly ClaudeDesktopUiCandidate[],
  binding: ClaudeDesktopModelBinding
): string | null {
  if (!binding || typeof binding !== 'object') {
    return null;
  }

  if (!Number.isFinite(binding.pid) || Math.floor(binding.pid) <= 0) {
    return null;
  }

  if (!Number.isFinite(binding.hwnd) || Math.floor(binding.hwnd) <= 0) {
    return null;
  }

  if (!Array.isArray(candidates)) {
    return null;
  }

  const matches: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    if (candidate.pid !== binding.pid || candidate.hwnd !== binding.hwnd) {
      continue;
    }

    if (candidate.controlType !== CLAUDE_DESKTOP_CONTROL_TYPE_BUTTON) {
      continue;
    }

    const model = parseClaudeDesktopModelChildLabel(candidate.name, candidate.modelChildLabel);
    if (!model) {
      continue;
    }

    matches.push(model);
  }

  return matches.length === 1 ? matches[0] : null;
}
