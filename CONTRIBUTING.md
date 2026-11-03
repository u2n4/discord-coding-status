# Contributing

Thanks for helping improve Discord Coding Status. This project is local-first, so changes should keep privacy, reliability, and simple setup ahead of extra features.

## Development Setup

Requirements:

- Node.js 20 or newer (22.13+ recommended for the built-in SQLite readers)
- Discord Desktop for manual Rich Presence testing

Install dependencies and build:

```sh
npm ci
npm run build
```

Run validation before opening a pull request:

```sh
npm test
npm run test:stress
npm pack --dry-run
```

## Pull Request Guidelines

- Discord shows only the tool's application name and one `Model: <label>` line. Do not add activity, project, quota, timers or any other field to presence.
- A model is shown only when it is proven from the tool's own data; when it is not, show the application name only. Never guess.
- Keep dependencies minimal. This daemon should remain easy to inspect and run locally.
- Update `README.md` and `.env.example` when adding or changing configuration.
- Add or update type checks/tests for behavior that can regress without Discord Desktop running.

## Local Manual Checks

Useful commands:

```sh
node dist/cli.js --help
node dist/cli.js state
node dist/cli.js hooks status
node scripts/diagnose-presence.js
DISCORD_CODING_STATUS_STATE_FILE="$(mktemp)" node dist/cli.js hook --tool codex --surface cli --status running --cwd "$PWD"
```

`scripts/diagnose-presence.js` prints the line each running tool would publish to Discord, except that it does not read Claude Desktop's model button.

Daemon mode uses the built-in Discord Application IDs. Override them only when testing applications you manage:

```sh
DISCORD_CODING_STATUS_CODEX_CLIENT_ID="YOUR_CODEX_APPLICATION_ID" \
DISCORD_CODING_STATUS_CLAUDE_CLIENT_ID="YOUR_CLAUDE_APPLICATION_ID" \
node dist/cli.js daemon
```
