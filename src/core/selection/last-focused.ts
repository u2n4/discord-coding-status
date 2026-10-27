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
