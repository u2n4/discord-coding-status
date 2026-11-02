'use strict';

import type { HookSessionState } from '../hooks/types';
import type { ActiveTool, ProcessInfo } from '../tools/types';
import { isMuseBinaryBasename } from '../detection/tool-detection';

// Native Muse hook instance selection.
//
// Several Muse sessions can be alive at once (a human TUI plus background
// workers), and newest-hook-wins would let a background worker's model steal
// the human session's display. Instance choice is therefore positive:
//   1. the session bound to the Muse PID under the foreground console wins;
//   2. else a lone live session wins (no competition, nothing to prove);
//   3. else the retained last-focused instance wins (Discord/null focus);
//   4. else the family stays app-only — never the newest session.
//
// Binding-invalid sessions (bound PID dead, creation mismatch) are excluded
// from candidacy. A foreground console that provably hosts a Muse instance no
// bound claimant binds vetoes bound claimants (the focused TUI is demonstrably
// not them); unbound manual sessions make no binding claim and keep the legacy
// explicit-hook behavior.

export interface MuseHookBinding {
  pid: number;
  createdAtMs: number;
}

export function extractMuseHookBinding(session: HookSessionState): MuseHookBinding | null {
  const pid = session.musePid;
  const createdAtMs = session.museCreatedAtMs;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs) || createdAtMs <= 0) {
    return null;
  }
  return { pid, createdAtMs };
}

/**
 * A binding is live only when its PID is still present with the EXACT
 * creation time and a Muse binary path. Any mismatch is PID reuse or process
 * end, and the binding is invalid. No command-line guessing: the executable
 * path basename must be a Muse binary, and a missing path fails closed.
 */
export function isMuseHookBindingLive(
  binding: MuseHookBinding,
  processes: readonly ProcessInfo[]
): boolean {
  const live = processes.find((candidate) => candidate.pid === binding.pid);
  if (!live || live.createdAtMs !== binding.createdAtMs) {
    return false;
  }
  const exe = typeof live.executablePath === 'string' ? live.executablePath : '';
  if (!exe.trim()) {
    return false;
  }
  const normalized = exe.replace(/\\/g, '/');
  return isMuseBinaryBasename(normalized.slice(normalized.lastIndexOf('/') + 1));
}

export type MuseDisplayVia = 'foreground' | 'single' | 'retained';

export type MuseDisplayResolution =
  | { kind: 'none'; liveSessionIds: [] }
  | { kind: 'app-only'; liveSessionIds: string[] }
  | { kind: 'session'; session: HookSessionState; via: MuseDisplayVia; liveSessionIds: string[] };

export interface MuseDisplayQuery {
  sessions: readonly HookSessionState[];
  isBindingLive: (binding: MuseHookBinding) => boolean;
  /** Exactly-one Muse PID under the foreground console, or null when unknown/ambiguous. */
  foregroundMusePid: number | null;
  rememberedSessionId: string | null;
}

export function resolveMuseDisplaySession(query: MuseDisplayQuery): MuseDisplayResolution {
  const sessions = [...query.sessions];
  if (sessions.length === 0) {
    return { kind: 'none', liveSessionIds: [] };
  }

  const live = sessions.filter((session) => {
    const binding = extractMuseHookBinding(session);
    return binding === null || query.isBindingLive(binding);
  });
  const liveSessionIds = live.map((session) => session.session_id);
  if (live.length === 0) {
    return { kind: 'app-only', liveSessionIds };
  }

  const foregroundMusePid = typeof query.foregroundMusePid === 'number' && query.foregroundMusePid > 0
    ? query.foregroundMusePid
    : null;
  const matched = foregroundMusePid !== null
    ? live.find((session) => extractMuseHookBinding(session)?.pid === foregroundMusePid) ?? null
    : null;

  if (foregroundMusePid !== null && !matched && live.some((session) => extractMuseHookBinding(session) !== null)) {
    return { kind: 'app-only', liveSessionIds };
  }
  if (matched) {
    return { kind: 'session', session: matched, via: 'foreground', liveSessionIds };
  }
  if (live.length === 1) {
    return { kind: 'session', session: live[0], via: 'single', liveSessionIds };
  }

  const remembered = query.rememberedSessionId;
  const retained = remembered
    ? live.find((session) => session.session_id === remembered) ?? null
    : null;
  if (retained) {
    return { kind: 'session', session: retained, via: 'retained', liveSessionIds };
  }
  return { kind: 'app-only', liveSessionIds };
}

/**
 * Rewrites the Muse hook tool to the resolved instance BEFORE presence
 * enrichment, so `details` formats from the winning session. Process-source
 * Muse tools (headless exec binding) and other families are untouched.
 */
export function applyMuseDisplayResolution(
  tools: readonly ActiveTool[],
  resolution: MuseDisplayResolution
): ActiveTool[] {
  if (resolution.kind === 'none') {
    return [...tools];
  }

  return tools.map((tool) => {
    if (!tool || tool.family !== 'muse' || tool.source !== 'hook') {
      return tool;
    }
    if (resolution.kind === 'app-only') {
      return { ...tool, model: null };
    }
    const session = resolution.session;
    return {
      ...tool,
      key: `state:${session.session_id}`,
      sessionId: session.session_id,
      model: session.model ?? null,
      updatedAt: session.updated_at
    };
  });
}

// Last positively foreground-associated Muse instance. Null/ambiguous/
// non-Muse foreground retains the entry while its session stays a live
// candidate; it clears only when the session is gone or binding-invalid —
// never because another hook is newer. Mirrors last-focused.ts one level down.
let rememberedMuseSessionId: string | null = null;

export function rememberMuseDisplaySession(
  associatedSessionId: string | null,
  aliveSessionIds: readonly string[]
): string | null {
  const alive = new Set(aliveSessionIds);

  if (associatedSessionId && alive.has(associatedSessionId)) {
    rememberedMuseSessionId = associatedSessionId;
    return rememberedMuseSessionId;
  }

  if (rememberedMuseSessionId && alive.has(rememberedMuseSessionId)) {
    return rememberedMuseSessionId;
  }

  rememberedMuseSessionId = null;
  return null;
}

export function getRememberedMuseDisplaySession(): string | null {
  return rememberedMuseSessionId;
}

export function resetRememberedMuseDisplaySessionForTests(): void {
  rememberedMuseSessionId = null;
}
