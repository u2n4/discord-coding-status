# discord-coding-status (Ali's minimal-display fork)

Upstream: https://github.com/howznguyen/discord-coding-status (v1.6.1).

## Display contract (do not weaken)

Discord shows ONLY:

```text
Playing <App>          <- Discord application identity per tool
Model: <raw model id>  <- details line, or absent when the model is unknown
```

Never sent: `startTimestamp`, activity, status, project, branch, package,
quota, context, effort, emoji, session counts. `SHOW_*`, detail levels, and
activity styles in config are inert. Model ids are raw (never guessed or
prettified); unknown model = application name only.

## How each tool resolves

| Tool | Active detection | Model source |
|---|---|---|
| Codex CLI | Lifecycle hooks + process | Hook input / transcript `turn_context` |
| Codex Desktop app | ChatGPT.exe in `OpenAI.Codex_*` (Classic excluded) | None — app-only (rollouts carry no PID; hook model only if Desktop ever fires one) |
| Claude Code | Lifecycle hooks + process | Hook input / transcript tail |
| Claude Desktop app | Claude.exe foreground window/process/package + UI Automation | Model selector button first text child (positive HWND/PID binding; Menu/ambiguous/missing fail closed to app-only); background CLI hook never overrides |
| Muse Code | `muse` / `muse-bin-*.exe` process | Headless `exec --session-id <UUID>` only (UUID command line to exact session log with open-segment, PID, freshness guards); bare TUI stays app-only (no PID binding); explicit hook `--model` still wins |
| Grok Code | Lifecycle hooks + process | Hook input explicit model only (cache first-key + config/fork guesses removed; unbound stays app-only) |
| OpenCode / Cursor / Pi | Process only | None (application name only) |

Selection: hook sessions outrank process detection; the Windows foreground
window (including terminal descendants) outranks everything when several
displayable tools compete. Tools without a Discord application ID are
excluded from selection so they can never blank a configured tool.

## Runtime layout on this machine

- Source: `codAi/projects/discord-coding-status` (this repo).
- Installed copy: `%LOCALAPPDATA%/discord-coding-status/app` (what actually runs).
- Config/state: `~/discord-coding-status/config.json`, `states.json`.
- Startup: Scheduled Task `DiscordCodingStatus` (ONLOGON, hidden VBS, no console).
- Logs: `%LOCALAPPDATA%/discord-coding-status/logs/`.

After changing `src/`, run `node dist/cli.js setup` from this repo to rebuild,
re-copy the runtime, and restart the daemon. The daemon refuses a second
instance (lock at `<stateFile>.daemon.lock`, stale-PID takeover).

## Test notes

- `npm test` runs the full suite (~50s). Config is `{}` by default; client IDs
  resolve to built-ins. Tests pin `DISCORD_CODING_STATUS_MUSE_CLIENT_ID=''` where
  ID-less behavior matters, so a real Muse ID in config cannot break them.
- Never call `*HookSessionFromArgs` in-process in tests: the session builder
  reads piped stdin, which blocks forever under `node --test`. Use `runCli`.

## Lessons — discord-coding-status

- [2026-10-27] When a `node --test` file stalls with no output after a daemon test, check for an in-process stdin read: the runner holds the stdin pipe open without EOF, so a sync `readFileSync(0)` freezes the loop. Exercise hook CLIs through subprocesses. (ctx: discord-coding-status)
- [2026-10-27] When asserting an Authorization header value, derive the expected string from the test fixture instead of inlining `Bearer <token>`: inline bearer literals get scrubbed on write. (ctx: discord-coding-status)
- [2026-10-27] When distinguishing Codex Desktop from ChatGPT Classic on Windows, match the Store package (`OpenAI.Codex_*`) and the exact `ChatGPT.exe` basename: Classic ships as `ChatGPT Classic.exe` under `OpenAI.ChatGPT-Desktop_*`. (ctx: discord-coding-status)
- [2026-10-27] When Codex Desktop shows no model, check `~/.codex/sessions` freshness first: the rollout fallback only trusts files newer than `STATE_MAX_AGE_MS`. (ctx: discord-coding-status)
- [2026-10-27] When `hooks setup` breaks the Windows scheduled task (LastTaskResult=1, missing VBS), check runtime-copy launcher preservation: the install-dir swap deletes `run-daemon.cmd` + `.vbs` unless carried across. (ctx: discord-coding-status)
- [2026-10-27] When hook writes fail with EPERM rename on Windows, retry EPERM/EACCES with backoff and rethrow: scanners and racers transiently lock the destination; never suppress or weaken atomicity. (ctx: discord-coding-status)
- [2026-10-27] When a session-file model has no PID binding (Muse/Codex Desktop), fail closed to app-only on disagreement between fresh files; never show the newest file's model as fact. (ctx: discord-coding-status)
- [2026-10-27] When attributing a model to Codex Desktop/Muse, require positive binding to the live session/hook/process: consensus among fresh files is NOT evidence, and one lone fresh file mislabels just as easily. Disable unbound scans; app-only when unproven. (ctx: discord-coding-status)
