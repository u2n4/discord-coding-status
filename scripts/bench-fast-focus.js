'use strict';

// Bounded fast-focus benchmark: exercises the production focus/state path with
// a controlled snapshot and fake RPC ACK. No real foreground reads, no Discord
// connection, no config/task changes.
//
// Measures: focus event -> cached attribution -> selection -> enrich -> fake
// RPC ACK. This is the daemon-side latency only; visible Discord UI rendering
// is measured separately by Manager with manual switches afterward.
//
// Usage (safe, no daemon, no network):
//   npm run build && node scripts/bench-fast-focus.js [--iterations=50]

const { performance } = require('node:perf_hooks');

function percentile(sorted, p) {
  if (!sorted.length) {
    return 0;
  }
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

async function main() {
  const iterationsArg = process.argv.find((arg) => arg.startsWith('--iterations='));
  const iterations = Math.min(200, Math.max(5, Number((iterationsArg || '').split('=')[1]) || 50));

  const { familyForForegroundProcess } = require('../dist/adapters/system/foreground');
  const { detectActiveTools } = require('../dist/core/detection/active-tools');
  const { rememberLastFocusedFamily, resetLastFocusedFamilyForTests } = require('../dist/core/selection/last-focused');
  const { selectNewestTool, enrichToolsForPresence, buildPresence, clientIdForTool, mergeActiveTools } = require('../dist/presence');
  const { toolProviders } = require('../dist/providers/registry');
  const { toolFamilyForTool } = require('../dist/quota');

  // Controlled snapshot: two terminals hosting Claude and Codex.
  const processes = [
    { pid: 100, line: 'C:\\Windows\\System32\\conhost.exe', raw: 'conhost', executablePath: 'C:\\Windows\\System32\\conhost.exe', commandLine: 'conhost.exe' },
    { pid: 101, ppid: 100, line: 'C:\\bin\\claude.exe', raw: 'claude', executablePath: 'C:\\bin\\claude.exe', commandLine: 'C:\\bin\\claude.exe', cpuMs: 5000 },
    { pid: 200, line: 'C:\\Windows\\System32\\conhost.exe', raw: 'conhost', executablePath: 'C:\\Windows\\System32\\conhost.exe', commandLine: 'C:\\Windows\\System32\\conhost.exe' },
    { pid: 201, ppid: 200, line: 'C:\\bin\\codex.exe', raw: 'codex', executablePath: 'C:\\bin\\codex.exe', commandLine: 'C:\\bin\\codex.exe', cpuMs: 6000 }
  ];

  const now = Date.now();
  const hookA = {
    key: 'state:claude', family: 'claude', source: 'hook', details: 'Model: claude-bench',
    state: '', updatedAt: now - 1000, model: 'claude-bench'
  };
  const hookB = {
    key: 'state:codex', family: 'codex', source: 'hook', details: 'Model: gpt-bench',
    state: '', updatedAt: now - 2000, model: 'gpt-bench'
  };

  resetLastFocusedFamilyForTests();

  // Fake RPC ACK: resolves on next tick like the mock client (record + ACK).
  const fakeRpcAck = async () => {
    await new Promise((resolve) => setImmediate(resolve));
  };

  const samples = [];
  let lastSelected = null;

  for (let index = 0; index < iterations; index += 1) {
    // Alternate focus A->B to exercise switching (100 = Claude terminal, 200 = Codex terminal).
    const foregroundPid = index % 2 === 0 ? 100 : 200;
    const startedAt = performance.now();

    const processTools = detectActiveTools(processes, toolProviders, { idleGraceMs: 5 * 60_000, activeCpuMs: 0 });
    const deduped = mergeActiveTools([hookA, hookB], processTools);

    const displayable = deduped.filter((tool) => {
      try {
        return Boolean(clientIdForTool(tool));
      } catch (_) {
        return true;
      }
    });
    const alive = new Set(displayable.map((tool) => toolFamilyForTool(tool)));
    const current = familyForForegroundProcess(foregroundPid, processes, toolProviders);
    const effective = rememberLastFocusedFamily(current, alive);
    const enriched = await enrichToolsForPresence(deduped);
    const displayableEnriched = enriched.filter((tool) => {
      try {
        return Boolean(clientIdForTool(tool));
      } catch (_) {
        return true;
      }
    });
    const selected = selectNewestTool(displayableEnriched, effective);
    if (selected) {
      buildPresence(selected);
      await fakeRpcAck();
      lastSelected = selected.family;
    }

    samples.push(performance.now() - startedAt);
  }

  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const max = samples[samples.length - 1] || 0;
  const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);

  console.log(JSON.stringify({
    iterations,
    lastSelected,
    meanMs: Number(mean.toFixed(2)),
    p50Ms: Number(p50.toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
    maxMs: Number(max.toFixed(2)),
    note: 'daemon-side focus->fake-RPC-ACK only; Discord UI rendering measured separately'
  }, null, 2));

  const provisionalTargetMs = 500;
  if (p95 > provisionalTargetMs) {
    console.error(`WARN: p95 ${p95.toFixed(1)}ms exceeds provisional warm target ${provisionalTargetMs}ms`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
