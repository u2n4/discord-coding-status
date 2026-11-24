'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mergeActiveTools, selectNewestTool } = require('../dist/presence');
const { detectActiveTools } = require('../dist/core/detection/active-tools');
const { toolProviders } = require('../dist/providers/registry');

const NOW = 1787131925747;

function hookTool(family, ageMs = 0, extra = {}) {
  return {
    key: `state:${family}`,
    family,
    source: 'hook',
    updatedAt: NOW - ageMs,
    ...extra
  };
}

function processTool(family, extra = {}) {
  // Process detection re-stamps `updatedAt` with the detection time on every
  // poll, so a process tool is always the freshest thing in the list.
  return { key: `${family}Cli`, family, source: 'process', updatedAt: NOW, ...extra };
}

test('a hook-reported session outranks process detection regardless of timestamps', () => {
  const claude = hookTool('claude', 30_000);
  const opencode = processTool('opencode');

  // The reported bug: `opencode serve` ran in the background while the user
  // typed in Claude Code, and its fresher timestamp won every poll.
  assert.equal(selectNewestTool([claude, opencode]).family, 'claude');
  assert.equal(selectNewestTool([opencode, claude]).family, 'claude');
});

test('a much older hook session still outranks an actively working process', () => {
  const staleClaude = hookTool('claude', 14 * 60_000);
  assert.equal(selectNewestTool([staleClaude, processTool('pi')]).family, 'claude');
});

test('ties inside one source fall back to the newest timestamp', () => {
  const older = hookTool('codex', 600_000);
  const newer = hookTool('claude', 1_000);
  assert.equal(selectNewestTool([older, newer]).family, 'claude');
  assert.equal(selectNewestTool([newer, older]).family, 'claude');

  const slowProcess = { ...processTool('opencode'), updatedAt: NOW - 5_000 };
  const freshProcess = processTool('pi');
  assert.equal(selectNewestTool([slowProcess, freshProcess]).family, 'pi');
});

test('process detection still wins when no hook session is reporting', () => {
  assert.equal(selectNewestTool([processTool('opencode')]).family, 'opencode');
  assert.equal(selectNewestTool([]), null);
});

test('tools carry the source that produced them', () => {
  const tools = detectActiveTools(
    [{ line: '/opt/homebrew/bin/codex', pid: 4242, cpuMs: 10_000 }],
    toolProviders,
    { idleGraceMs: 5 * 60_000, activeCpuMs: 0 }
  );

  assert.ok(tools.length > 0, 'expected the codex CLI to be detected');
  for (const tool of tools) {
    assert.equal(tool.source, 'process');
  }
});

test('merging keeps one tool per family with the hook report ahead of the process', () => {
  const merged = mergeActiveTools([hookTool('claude', 30_000)], [
    processTool('claude'),
    processTool('opencode')
  ]);

  assert.deepEqual(merged.map((tool) => tool.family), ['claude', 'opencode']);
  assert.equal(merged[0].source, 'hook', 'the hook report represents the claude family');
  assert.equal(selectNewestTool(merged).family, 'claude');
});

test('unfocused fallback follows priority claude -> codex -> antigravity -> running -> null', () => {
  const antigravity = hookTool('antigravity', 1_000);
  const codex = hookTool('codex', 30_000);
  const claude = hookTool('claude', 60_000);
  const opencode = processTool('opencode');

  // Even when antigravity or codex is newer, unfocused fallback prefers claude first.
  assert.equal(selectNewestTool([antigravity, codex, claude, opencode]).family, 'claude');
  // Without claude, codex beats newer antigravity and opencode.
  assert.equal(selectNewestTool([antigravity, codex, opencode]).family, 'codex');
  // Without claude or codex, antigravity beats other running tools.
  assert.equal(selectNewestTool([opencode, antigravity]).family, 'antigravity');
  // Without any of the top 3, falls back to whatever else is running, or null if empty.
  assert.equal(selectNewestTool([opencode]).family, 'opencode');
  assert.equal(selectNewestTool([]), null);

  // Explicit/remembered preferredFamily still overrides fallback priority.
  assert.equal(selectNewestTool([antigravity, codex, claude], 'antigravity').family, 'antigravity');
  assert.equal(selectNewestTool([antigravity, codex, claude], 'codex').family, 'codex');
});
