'use strict';

export type VisibleEffortLabel =
  | 'XHigh'
  | 'Max'
  | 'Ultra'
  | 'Ultracode'
  | 'XHigh · Ultracode'
  | 'Max · Ultracode';

type BaseVisibleEffort = 'XHigh' | 'Max';

const KNOWN_HIDDEN_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'standard',
  'extended',
  'auto',
  'default',
  'thinking',
  'ultrathink',
  'fast',
  'xlow'
]);

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function classifySingleEffort(normalized: string): BaseVisibleEffort | 'Ultra' | 'Ultracode' | 'hidden' | null {
  if (!normalized) {
    return null;
  }
  if (normalized === 'ultracode' || normalized === 'ultra code') {
    return 'Ultracode';
  }
  if (normalized === 'ultra') {
    return 'Ultra';
  }
  if (normalized === 'xhigh' || normalized === 'x high' || normalized === 'extra high' || normalized === 'extra') {
    return 'XHigh';
  }
  if (normalized === 'max' || normalized === 'max effort') {
    return 'Max';
  }
  if (KNOWN_HIDDEN_EFFORTS.has(normalized)) {
    return 'hidden';
  }
  return null;
}

// Only the highest reasoning tiers appear in Discord (XHigh, Max, Ultra,
// Ultracode). When Ultracode is paired with XHigh or Max, both show together
// ("XHigh · Ultracode" / "Max · Ultracode"); when paired with a lower tier
// (e.g. "High · Ultracode"), only "Ultracode" is shown. Lower or default
// levels alone stay hidden.
export function displayEffortLabel(effort: unknown): VisibleEffortLabel | null {
  if (typeof effort !== 'string') {
    return null;
  }
  const trimmed = effort.trim();
  if (!trimmed) {
    return null;
  }

  const single = classifySingleEffort(normalizeToken(trimmed));
  if (single === 'XHigh' || single === 'Max' || single === 'Ultra' || single === 'Ultracode') {
    return single;
  }
  if (single === 'hidden') {
    return null;
  }

  // Handle combined values such as "Max · Ultracode", "Max+Ultracode",
  // "Extra High · Ultracode", "High · Ultracode", or space-separated
  // "Max Ultracode" / "Extra Ultracode". Every part must be a recognized
  // effort token so unrelated text always fails closed to null.
  const parts = trimmed
    .split(/[·•,+/|]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const tokens: string[] = [];
  for (const part of parts) {
    const norm = normalizeToken(part);
    if (classifySingleEffort(norm) !== null) {
      tokens.push(norm);
      continue;
    }
    const ultraEdge = norm.match(/^(?:(ultracode|ultra code)\s+(.+)|(.+)\s+(ultracode|ultra code))$/);
    if (ultraEdge) {
      const ultraPart = ultraEdge[1] || ultraEdge[4];
      const otherPart = (ultraEdge[2] || ultraEdge[3] || '').trim();
      if (classifySingleEffort(otherPart) !== null) {
        tokens.push(otherPart, ultraPart);
        continue;
      }
    }
    return null;
  }

  if (tokens.length === 0) {
    return null;
  }

  let hasUltracode = false;
  let hasUltra = false;
  let base: BaseVisibleEffort | null = null;
  for (const token of tokens) {
    const kind = classifySingleEffort(token);
    if (kind === null) {
      return null;
    }
    if (kind === 'Ultracode') {
      hasUltracode = true;
    } else if (kind === 'Ultra') {
      hasUltra = true;
    } else if (kind === 'XHigh') {
      base = 'XHigh';
    } else if (kind === 'Max' && base !== 'XHigh') {
      base = 'Max';
    }
  }

  if (hasUltracode) {
    return base ? `${base} · Ultracode` : 'Ultracode';
  }
  if (hasUltra) {
    return 'Ultra';
  }
  return base;
}

export function mergeEffortWithUltracode(
  effort: string | null | undefined,
  ultracode: boolean
): string | null {
  const cleaned = typeof effort === 'string' && effort.trim() ? effort.trim() : null;
  if (!ultracode) {
    return cleaned;
  }
  const visible = cleaned ? displayEffortLabel(cleaned) : null;
  if (visible === 'XHigh' || visible === 'XHigh · Ultracode') {
    return 'XHigh · Ultracode';
  }
  if (visible === 'Max' || visible === 'Max · Ultracode') {
    return 'Max · Ultracode';
  }
  return 'Ultracode';
}
