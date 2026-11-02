'use strict';

export interface HookSessionState {
  tool: string;
  surface: string;
  status: string;
  session_id: string;
  cwd: string;
  updated_at: number;
  started_at?: number;
  project?: string;
  package?: string;
  title?: string;
  activity?: string;
  model?: string;
  effort?: string;
  context?: string;
  claude_quota_eligible?: boolean;
  /**
   * Native Muse hook binding: PID + creation time (Unix ms) of the owning
   * Muse process, derived from the receiver's own ancestor chain. Absent on
   * manual/unbound sessions; a dead PID or creation mismatch invalidates.
   */
  musePid?: number;
  museCreatedAtMs?: number;
}

export interface HookStateFile {
  version: 1;
  sessions: Record<string, HookSessionState>;
}
