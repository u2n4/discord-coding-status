'use strict';

// Prints every AI tool the daemon can see right now and the Discord line each
// would publish if it were the selected one. Read-only: it never connects to
// Discord or writes state. Usage: node scripts/diagnose-presence.js

const path = require('node:path');

const dist = path.join(__dirname, '..', 'dist');
const { getProcessList } = require(path.join(dist, 'adapters/system/processes'));
const { setCachedProcessList } = require(path.join(dist, 'adapters/system/process-cache'));
const { detectActiveTools } = require(path.join(dist, 'core/detection/active-tools'));
const { toolProviders } = require(path.join(dist, 'providers/registry'));
const { detectStateTools, mergeActiveTools, enrichToolForPresence, clientIdForTool } = require(path.join(dist, 'presence'));

async function main() {
  const processList = await getProcessList();
  // Enrichment reads the daemon's process cache, as the daemon fills it.
  setCachedProcessList(processList);
  const stateTools = detectStateTools();
  // Two passes: the first only seeds the CPU-activity cache.
  detectActiveTools(processList, toolProviders, {});
  const processTools = detectActiveTools(processList, toolProviders, { idleGraceMs: 24 * 60 * 60_000, activeCpuMs: 0 });
  const merged = mergeActiveTools(stateTools, processTools);
  for (const tool of merged) {
    const enriched = await enrichToolForPresence(tool);
    console.log([
      (tool.providerId || tool.family).padEnd(16),
      `source=${tool.source || '?'}`.padEnd(15),
      `pid=${tool.processInfo?.pid || '-'}`.padEnd(11),
      `raw=${tool.model || '-'}`.padEnd(32),
      `discord=${clientIdForTool(tool) ? (enriched?.details || '(app name only)') : '(no Discord app id)'}`
    ].join(' '));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
