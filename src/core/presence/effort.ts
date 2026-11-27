'use strict';

export type VisibleEffortLabel = 'XHigh' | 'Max' | 'Ultracode';

// Only the three highest reasoning tiers appear in Discord (XHigh, Max,
// Ultracode). Lower or default levels (none, minimal, low, medium, high,
// standard, extended, auto, default, thinking, ultrathink) stay hidden.
export function displayEffortLabel(effort: unknown): VisibleEffortLabel | null {
  if (typeof effort !== 'string') {
    return null;
  }
  const normalized = effort
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!normalized) {
    return null;
  }
  if (normalized === 'ultracode' || normalized === 'ultra code') {
    return 'Ultracode';
  }
  if (normalized === 'xhigh' || normalized === 'x high' || normalized === 'extra high' || normalized === 'extra') {
    return 'XHigh';
  }
  if (normalized === 'max' || normalized === 'max effort') {
    return 'Max';
  }
  return null;
}
