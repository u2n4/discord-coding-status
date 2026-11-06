# discord-coding-status (minimal-display build)

Repo: https://github.com/u2n4/discord-coding-status (standalone since 2026-11-03).
Originally based on https://github.com/howznguyen/discord-coding-status (v1.6.1, MIT; credit stays in LICENSE).

## Display contract (do not weaken)

Discord shows ONLY:

```text
Playing <App>          <- Discord application identity per tool
Model: <app label>     <- details line, or absent when the model is unknown
```

Never sent: `startTimestamp`, activity, status, project, branch, package,
quota, context, effort, emoji, session counts. `SHOW_*`, detail levels, and
activity styles in config are inert. The model is resolved from evidence
(never guessed), then shown the way the tool itself writes it (since
2026-11-03): `src/providers/model-label.ts` maps a resolved id to the tool's
own label, from the tool's model list where one exists (Codex and Grok
`models_cache.json`, `agy models`), effort brackets dropped: "Opus 5.5",
"GPT-6.1 Sol" (Codex Desktop) / "GPT-6.1-Sol" (Codex CLI), "Gemini 4 Argon",
"Grok 4.7", "Muse Spark 1.3". An id with no known label is shown unchanged;
unknown model = application name only.

## How each tool resolves

| Tool | Active detection | Model source |
|---|---|---|
| Codex CLI | Lifecycle hooks + process | Hook input / transcript `turn_context`; `config.toml` top-level `model` when newer than the hook (a `/model` change) or when the hook has none. Process-only: the live process's `--model`/`-m`/`-c model=` flag, unless the config's model value was seen changing after the process started. Unlisted `gpt-*` slugs are labelled in the cached list's style |
| Codex Desktop app | ChatGPT.exe in `OpenAI.Codex_*` (Classic excluded) | Hook model if Desktop fires one, else the latest composer pick in `.codex-global-state.json` (verified live process only). The CLI never reads this file |
| Claude Code | Lifecycle hooks + process | Hook input / transcript tail |
| Claude Desktop app | Claude.exe foreground window/process/package + UI Automation | Model selector button first text child (positive HWND/PID binding). When unreadable (Code tab), the session last opened or typed in, from Desktop's own `claude-code-sessions/<account>/<organization>/local_*.json` (`cliSessionId`, `model`, `lastFocusedAt`, `latestUserFrameAt`) under the running Claude.exe's `--user-data-dir`, else the fixed `%APPDATA%` and Store paths, names the model: its fresh `claude_entrypoint=claude-desktop` hook, else its record, else its runner's `--model`, else app-only. With no usable record, the Code-tab runners (`claude --output-format stream-json --model=<id> [--resume=<id>]` children of Claude.exe) name the model if all agree. Terminal hooks never override. The `empty-state-draft` hook is ignored and `default` is never a model |
| Muse Code | Lifecycle hooks + process | Hook input `model` per bound session (global `settings.json` is never shown) (receiver ancestor PID+creation binding; foreground-associated or retained instance wins, ambiguity fails app-only); headless `exec --session-id <UUID>` keeps its guarded process model; TUI without hooks: the single session whose UUIDv7 time is within 3 s of the process start, then the session of the latest `tui-history.jsonl` entry once that startup session appears there; explicit hook `--model` still wins |
| Grok Code | Lifecycle hooks + process | Hook input explicit top-level model, or the bound session's `summary.json` `current_model_id`; process-only grok.exe binds through `~/.grok/active_sessions.json` (pid -> session). Config default and nested `tool_input` fields are never used |
| Antigravity CLI (`agy`) | Process (`agy.exe`) + the shared hooks.json | Last `Propagating selected model override to backend: label="..."` in `~/.gemini/antigravity-cli/cli.log`, else `settings.json` `model` |
| Antigravity | Hooks + process | `last_selected_agent_model` placeholder in `antigravity_state.pbtxt`, resolved first through the picker's own list (`GetCascadeModelConfigData` on the local `language_server.exe` HTTP port from `%APPDATA%/Antigravity/logs/language_server.log`, CSRF token from its command line, stored in `cache/antigravity-models.json`; unknown placeholder retried every 30 s, so new models need no update), then pairs learned from its `conversations/*.db` `gen_metadata` records (seeded); still unknown = app-only. Transcripts are never mined |
| OpenCode | Process | `~/.local/state/opencode/model.json` `recent[0]`, named from `~/.cache/opencode/models.json` |
| Cursor app | Process | `state.vscdb` `aiSettings.modelConfig.composer.modelName`, labelled by `availableDefaultModels2` `inputboxShortModelName` (`default` = "Auto"); Cursor CLI stays app-only |
| Pi | Process only | None (application name only) |

Selection: hook sessions outrank process detection; the Windows foreground
window (including terminal descendants) outranks everything when several
displayable tools compete; with no focused or remembered family, Claude wins over Codex regardless of source. Within one family the desktop app wins over its CLI unless a terminal running that CLI is in front (`foregroundSurfaceForProcess`). Within Muse, competing hook sessions resolve by positive instance binding: the session bound to the Muse PID under the focused console wins, else the retained last-focused instance, else app-only (never newest-hook). Tools without a Discord application ID are
excluded from selection so they can never blank a configured tool.

## Runtime layout on this machine

- Source: `codAi/projects/discord-coding-status` (this repo).
- Installed copy: `%LOCALAPPDATA%/discord-coding-status/app` (what actually runs).
- Config/state: `~/discord-coding-status/config.json`, `states.json`.
- Startup: Scheduled Task `DiscordCodingStatus` (ONLOGON, hidden VBS, no console).
- Logs: `%LOCALAPPDATA%/discord-coding-status/logs/`.

Background cost: one persistent PowerShell answers the process census over
stdin (no per-census spawn), and the foreground helper is an event hook
(`SetWinEventHook`) compiled once, not a polling loop. Never put a command line
containing `discord-coding-status` and `daemon` in a filter that kills
processes: setup now stops only node/bun running `cli.js daemon`.

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
- [2026-10-27] When writing Muse hook commands for Windows, use plain double-quoted cmd-compatible args: Muse dispatches hooks via cmd.exe (proven receiver ancestry node <- cmd <- muse-bin), so a PowerShell call operator fails to parse. (ctx: discord-coding-status)
- [2026-10-27] When several Muse hook sessions compete, resolve by positive foreground-instance binding (bound PID under the focused console, else retained instance, else app-only); newest-hook-wins lets a background worker steal the human TUI. (ctx: discord-coding-status)
- [2026-11-06] When Claude Desktop's Code tab loses its model, check for idle sessions: their `stream-json` runners stay alive for days, so "all runners agree" fails as soon as one old session used another model. Desktop's own session records name the session in use. Combine `lastFocusedAt` with `latestUserFrameAt`, because a message reached a session without moving its `lastFocusedAt`. `latestUserFrameAt` also moves on injected messages such as a subagent's report, so it means "last message delivered", not "last typed", and typing in a split-view pane does not move `lastFocusedAt`. A session leading only through a message therefore stands only when the session opened last has the same model; otherwise app-only. Half the records have no `model` field, so keep the runner's `--model` as the next source. A new session's runner has no id in its argv (5 of 8 live runners had neither `--resume` nor `--session-id`), so never require a record to have a live runner. The record followed the model switches in 113 of 116 transcripts checked. Take the folder from the running Claude.exe's `--user-data-dir`: on 2026-11-06 a restart moved all Desktop data from `Packages/Claude_*/LocalCache/Roaming/Claude` to `%LOCALAPPDATA%/Claude-Data/claude_<id>`, and a fixed path silently fell back to the old logic. (ctx: discord-coding-status)
- [2026-11-03] When adding npm lifecycle scripts (`prepare`, `postinstall`), remember setup runs `npm install --omit=dev` inside the copied runtime, which has no `scripts/` or `src/`: a `prepare` build there fails with `MODULE_NOT_FOUND scripts/clean-dist.js`. Never add one without running `node dist/cli.js setup` after it. (ctx: discord-coding-status)
- [2026-11-03] When documenting an install command, prove it in a throwaway prefix first: `npm install -g github:<repo>` on npm 11.19 runs the git-prepare install in global mode, so devDependencies never land and `tsc` resolves to a global TypeScript (TS5107 / TS2688 'node'). The supported install is a clone + `npm ci` + `npm run build` + `node dist/cli.js setup`. (ctx: discord-coding-status)
- [2026-11-03] When publishing to npm: the package is `@u2n4/discord-coding-status` (the unscoped name belongs to howznguyen). New npm accounts can only enrol a security key (Windows Hello) for 2FA, and `npm publish` fails with E403 until 2FA is on; it then prints an `npmjs.com/auth/cli/...` URL to approve. Right after a publish, `npm view` serves a cached 404 for minutes: check with `--prefer-online` or the registry URL. Later releases: bump `version`, push tag `v<version>`, and `publish.yml` publishes through trusted publishing. Pushing a tag for an already-published version fails that workflow. (ctx: discord-coding-status)
