# Fast focus switching

Display contract is unchanged: Discord shows only `Playing <AI App>` plus
`Model: <raw model id>` when the model is positively bound. Unknown models stay
absent. Privacy, config keys, Discord IDs, hooks, lifecycle isolation, and the
atomic state retry are preserved.

## Architecture

- Slow health census (10s, `POLL_INTERVAL_MS`): full `Win32_Process` snapshot
  replaces the cache in `src/adapters/system/process-cache.ts`.
- Fast path (focus/hook/model events): reads the cache only. Unknown foreground
  PIDs merge a small targeted subtree (root + descendants, depth <= 4) with
  single-flight + 2s TTL dedup. No full census ever runs at sampler rate.
- Foreground sampler (Windows only): ONE hidden persistent PowerShell child
  (`src/adapters/system/foreground-watch.ts`, ~120ms) calling
  `GetForegroundWindow`/`GetWindowThreadProcessId` with `Add-Type` once. It
  emits PID-only lines on change; no titles or window text. The existing
  oneshot `getForegroundPid()` is fallback only while the watcher has no data
  or is unhealthy — never a second helper while healthy.
- Last-focused memory (`src/core/selection/last-focused.ts`): remembers the
  last displayable alive AI family. Null/browser/Discord/game focus retains it;
  the entry clears only when its family leaves the alive displayable set, never
  because another hook is newer. Missing-ID families are excluded by the caller
  and can neither be remembered nor blank a configured tool.
- Muse instance selection (`src/core/selection/muse-instance.ts`): competing
  Muse hook sessions resolve by positive binding, not newest-hook. The session
  bound to the Muse PID under the focused console wins; else the retained
  last-focused instance; else the family stays app-only. Binding-invalid
  (dead PID / creation mismatch) sessions are excluded, and shared terminal
  panes fail closed. Reuses the cached process snapshot and foreground PID —
  no new census.
- Selected-model watch (`src/adapters/system/selected-model-watch.ts`): watches
  ONLY the currently selected positively bound Muse exec session file so bound
  model switches publish without a new focus event. No global inference; bare
  TUI, ambiguous, and unbound tools stay unwatched and app-only.
- Publish order (`updateActivities`): the new target is published BEFORE the
  previous app is cleared, so a not-yet-ready connection never blanks Discord.
  When the new target cannot publish, the previous activity is retained and the
  next pass retries. Signature dedup is retained. No numeric Discord rate limit
  is assumed (official `SET_ACTIVITY` docs publish none); rapid events are
  coalesced by generation and RPC errors/backpressure trigger retry.

## Native-helper lifecycle

- Normal daemon exit: daemon closes the helper stdin (EOF) and SIGTERMs the
  child, with a SIGKILL fallback. No orphan, no new scheduled task.
- Daemon crash/parent death: the helper polls its parent PID (~1s) and probes
  stdin EOF every tick (non-blocking `BeginRead`/`WaitOne(0)`); either condition
  exits the child promptly.
- Toggles: `DISCORD_CODING_STATUS_FOREGROUND_WATCH=off` disables the sampler
  (oneshot fallback). `DISCORD_CODING_STATUS_FOREGROUND_SAMPLE_MS` overrides
  the 120ms cadence (clamped 50-1000; approved band 100-150ms).

## Observation interface

- `getForegroundWatcherStats()` (`dist/adapters/system/foreground-watch`):
  `{ available, pid, startedAt, sampleMs, changes, lastPid, restarts,
  lastError, uptimeMs, estimatedSamples }`.
- `getProcessCacheStats()` (`dist/adapters/system/process-cache`):
  `{ size, updatedAt, refreshAttempts, refreshSucceeded, refreshDeduped,
  lastRefreshMs, inFlight }`.
- Daemon log lines: `Foreground watcher started (PID <pid>, <ms>ms sampler).`,
  `Foreground PID changed to ...`, `Fast pass ...`, `Watching selected Muse
  model file ...`.

Helper CPU/memory are measured, not assumed. With the watcher PID from the log
or stats, run in an admin PowerShell:

```powershell
Get-Process -Id <watcherPid> | Select-Object Id, ProcessName, WorkingSet64, PagedMemorySize64, CPU
Get-Counter "\Process(powershell*)\% Processor Time" -SampleInterval 1 -MaxSamples 5
```

Focus->RPC-ACK is measured separately from visible Discord UI rendering: the
benchmark below times daemon-side publish to a fake ACK; Manager measures live
UI switches afterward with manual A/B/Discord changes.

## Tests and benchmark (safe, isolated)

```powershell
npm run build
node --test --test-concurrency=1 test/fast-focus-switching.test.js
npm test
node scripts/bench-fast-focus.js --iterations=50
```

- `fast-focus-switching.test.js` covers A->B->Discord/browser retention, game
  ignore, dead-B fallback, missing-ID exclusion, bound model change without
  focus, rapid A/B latest-wins, cache/dedup bounds, sampler script properties,
  and helper normal/parent-death/stdin-EOF cleanup. Daemon cases use tmpdir
  isolation (`createTestEnvironment`); no real task, config, or runtime is
  touched; no UI automation.
- `bench-fast-focus.js` is bounded (default 50, max 200 iterations, fake RPC
  ACK, controlled snapshot, no network/daemon). Provisional warm target
  250-500ms focus->RPC-ACK until measured live.

## Limitations

- Process death is observed at the next slow census (<=10s) or targeted
  refresh; focus switches themselves are fast.
- Hook-only mode (`PROCESS_DETECTION=off`) has no PID attribution, so
  foreground retention needs detection on (production default).
- The sampler is Windows-only; other platforms use the oneshot fallback.
- `estimatedSamples` is uptime/sampleMs, not an observed tick counter, because
  the helper emits only on PID change by design.
