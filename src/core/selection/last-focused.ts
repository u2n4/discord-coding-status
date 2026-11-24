'use strict';

import type { ToolFamily } from '../tools/types';

// Last-focused displayable AI family.
//
// A->B->Discord/browser/game retains B while B is alive: null and non-AI
// foreground events (browser, Discord, games, unknown PIDs) never clear the
// remembered family. The entry is cleared only when its family is truly gone
// from the alive displayable set — never because another hook is newer.
// Families without a Discord application ID are excluded by the caller via the
// alive set, so they can neither be remembered nor blank a configured tool.

let lastFocusedFamily: ToolFamily | null = null;

function aliveSet(alive: ReadonlySet<ToolFamily> | readonly ToolFamily[]): ReadonlySet<ToolFamily> {
  return alive instanceof Set ? alive : new Set(alive);
}

export function resolveEffectivePreferredFamily(
  currentForeground: ToolFamily | null,
  remembered: ToolFamily | null,
  alive: ReadonlySet<ToolFamily> | readonly ToolFamily[]
): ToolFamily | null {
  const aliveFamilies = aliveSet(alive);

  if (currentForeground && aliveFamilies.has(currentForeground)) {
    return currentForeground;
  }

  if (remembered && aliveFamilies.has(remembered)) {
    return remembered;
  }

  return null;
}

export function rememberLastFocusedFamily(
  foregroundFamily: ToolFamily | null,
  aliveDisplayableFamilies: ReadonlySet<ToolFamily> | readonly ToolFamily[]
): ToolFamily | null {
  const aliveFamilies = aliveSet(aliveDisplayableFamilies);

  if (foregroundFamily && aliveFamilies.has(foregroundFamily)) {
    lastFocusedFamily = foregroundFamily;
    return lastFocusedFamily;
  }

  if (lastFocusedFamily && aliveFamilies.has(lastFocusedFamily)) {
    return lastFocusedFamily;
  }

  lastFocusedFamily = null;
  return null;
}

export function getLastFocusedFamily(): ToolFamily | null {
  return lastFocusedFamily;
}

export function clearLastFocusedFamily(): void {
  lastFocusedFamily = null;
}

export function resetLastFocusedFamilyForTests(): void {
  lastFocusedFamily = null;
}

export const FOREGROUND_SETTLE_MS = 250;

/**
 * Debounces transient Windows focus bounces (e.g. Alt-Tab pass-throughs or
 * popup flashes lasting < settleMs) so Discord presence does not flicker
 * clear/set between apps. The first foreground observation settles at once.
 */
export class ForegroundPidSettler {
  private settledPid: number | null | undefined = undefined;
  private rawPid: number | null | undefined = undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onSettled: (pid: number | null) => void,
    private readonly settleMs: number = FOREGROUND_SETTLE_MS
  ) {}

  current(): number | null | undefined {
    return this.settledPid;
  }

  observe(pid: number | null): void {
    if (pid === this.rawPid && this.settledPid !== undefined) {
      return;
    }
    this.rawPid = pid;

    if (this.settledPid === undefined) {
      this.settledPid = pid;
      this.onSettled(pid);
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (pid === this.settledPid) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.rawPid !== this.settledPid) {
        this.settledPid = this.rawPid as number | null;
        this.onSettled(this.settledPid);
      }
    }, this.settleMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  reset(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.settledPid = undefined;
    this.rawPid = undefined;
  }
}
