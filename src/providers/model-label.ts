'use strict';

// Turns a resolved model id into the label the tool's own app shows, so Discord
// reads the same as the model picker the user just used ("Opus 5.5",
// "Gemini 4 Argon"). Effort/tier suffixes and context-window tags are dropped.
// Ids that do not match a known shape are returned unchanged.

const CLAUDE_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-[a-z0-9@-]+)?(?:\[[^\]]*\])?$/i;
const GEMINI_ID = /^gemini-(\d+(?:\.\d+)?)-([a-z]+)(?:-[a-z0-9@.-]+)?$/i;
const GPT_OSS_ID = /^gpt-oss-(\d+b)(?:-[a-z]+)?$/i;

function titleWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function claudeLabel(model: string): string | null {
  const match = model.match(CLAUDE_ID);
  if (!match) {
    return null;
  }
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `${titleWord(match[1])} ${version}`;
}

export function displayModelLabel(family: string | undefined, model: string): string {
  const id = model.trim();
  if (!id) {
    return id;
  }

  if (family === 'claude') {
    // Claude Code and Claude Desktop both show "Opus 5.5".
    return claudeLabel(id) || id;
  }

  if (family === 'antigravity') {
    // Antigravity's picker shows "Claude Opus 5.5 (High)", "Gemini 4 Argon
    // (Medium)", "GPT OSS 120B"; the effort in brackets is dropped.
    const claude = claudeLabel(id);
    if (claude) {
      return `Claude ${claude}`;
    }
    const gemini = id.match(GEMINI_ID);
    if (gemini) {
      return `Gemini ${gemini[1]} ${titleWord(gemini[2])}`;
    }
    const gptOss = id.match(GPT_OSS_ID);
    if (gptOss) {
      return `GPT OSS ${gptOss[1].toUpperCase()}`;
    }
    return id;
  }

  return id;
}
