# Phi harness MVP

Phi is a durable, local coordination harness for concurrent coding agents sharing one Git workspace. It runs on Bun, journals coordination state in `~/.phi/runtime.db`, uses a restricted persistent Pi session as its headless coordinator, presents a Phi-owned OpenTUI interface, and integrates the official Cursor, Claude Agent, and OpenAI Codex SDKs behind one adapter contract.

The MVP intentionally does **not** serialize mutating workers. Reads can become stale, writes can overlap, and the last filesystem write wins. Git commits are recoverable global workspace checkpoints; they are not authoritative per-job diffs.

## Requirements and install

- Bun 1.3.12 (the validated runtime baseline)
- Git installed; Phi initializes the managed workspace automatically when needed
- A supported Pi model credential for the default coordinator engine
- Optional worker credentials for Cursor, Claude, or Codex

```sh
cd /path/to/phi
bun install
bun run doctor -- --workspace /path/to/managed-workspace
```

Phi keeps runtime state separate from the managed workspace. The default is `~/.phi`; override it with `PHI_HOME` or `--runtime`. Runtime directories are mode `0700` and the SQLite database is mode `0600`.

On the first `doctor` or start, Phi runs `git init` if the workspace is not already its own repository. If it has no commits, Phi creates one baseline commit containing all non-ignored existing files (or an empty baseline for an empty directory). An established repository and any of its uncommitted changes are left untouched until the normal global-checkpoint flow runs.

## Authentication

Phi defaults to `PHI_CREDENTIAL_MODE=native`. It does not copy credentials; each harness asks its official SDK to use the authentication available in its normal user-home location:

| Harness | Native authentication lookup                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------- |
| Cursor  | `CURSOR_API_KEY`, then the Cursor SDK login store (normally `~/.cursor/sdk/auth.json`)                                    |
| Claude  | `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`, Claude Code's user login (macOS Keychain or `~/.claude/.credentials.json`) |
| Codex   | `OPENAI_API_KEY`, then the Codex CLI/IDE login (`~/.codex/auth.json` or the OS credential store)                          |
| Pi      | Pi's normal user auth and model stores (normally `~/.pi/agent/auth.json` and `models.json`)                               |

Claude, Codex, and Pi can normally reuse their existing CLI/SDK user-home login. Cursor is different: the Cursor Agent SDK does **not** reuse the Cursor desktop application's login. If `doctor` reports that Cursor login is required, start Phi, press `Ctrl+P`, and choose **Log in to Cursor**. The SDK opens a browser flow and stores its own credential under `~/.cursor/sdk/auth.json`. A configured `CURSOR_API_KEY` takes precedence over that store; remove or correct a stale environment value if Cursor reports an invalid key.

Native mode may also read a harness's user-level configuration: notably `~/.codex` for Codex and Claude Code's global configuration. Phi still keeps its SQLite journal, coordinator transcript, worker observations, and logs under `~/.phi`.

For an isolated Phi-specific login, set `PHI_CREDENTIAL_MODE=isolated` or pass `--credential-mode isolated`. Isolated mode uses provider environment variables or these owner-readable files:

| Adapter | Environment                   | Isolated credential file                               |
| ------- | ----------------------------- | ------------------------------------------------------ |
| Cursor  | `CURSOR_API_KEY`              | `~/.phi/credentials/cursor-api-key`                    |
| Claude  | `ANTHROPIC_API_KEY`           | `~/.phi/credentials/anthropic-api-key`                 |
| Codex   | `OPENAI_API_KEY`              | `~/.phi/credentials/openai-api-key`                    |
| Pi      | provider-specific environment | `~/.phi/credentials/pi-auth.json` and `pi-models.json` |

Set isolated key files to mode `0600`. Phi reads the file before its environment-variable fallback and never writes credentials into the managed workspace or Git. Set `PHI_COORDINATOR_MODEL=provider/model-id` (or `--coordinator-model`) to choose an exact registered Pi model.

Interactive Cursor browser login is disabled in isolated mode; provision the isolated key file or environment variable explicitly.

## Run

Start the conversation-first Phi TUI:

```sh
bun run start -- tui --workspace /path/to/managed-workspace
```

Type ordinary requests into the composer and press Enter. Phi's Pi coordinator knows the registered `fake`, `cursor`, `claude`, and `codex` harnesses through its restricted `list_workers` tool and validates every adapter, root-model, and reasoning-effort selection against the current catalog. Explicit user choices win when selectable; otherwise the coordinator chooses a ready harness and an adequate advertised model tier. The conversation follows new content automatically and can include a muted coordinator trace showing Pi tool calls, officially exposed non-redacted reasoning, and the coordinator's final assistant output. This trace is a live projection of Pi's session events, not a second delivery channel or a durable job record. Jobs and worker streams stay out of the main conversation:

- `Ctrl+P` opens commands, harness status, and Cursor SDK login.
- `Ctrl+T` hides or shows coordinator details.
- `Ctrl+A` toggles internal activity details.
- `Esc` closes an overlay; `Ctrl+C` quits without discarding durable state.

Direct mode is not needed for normal use. It remains a credential-free deterministic development/recovery interface:

```sh
bun run start -- tui --direct --workspace /path/to/managed-workspace
bun run start -- once --direct "/dispatch fake mutating implement the task" --workspace /path/to/managed-workspace
```

Direct-mode commands are:

- `/dispatch <fake|cursor|claude|codex> <read_only|mutating> <task>`
- `/follow <job-id> <text>` for a durable job in `needs_input`
- `/cancel <job-id>` to persist cancellation intent before contacting the adapter

Configuration variables include `PHI_WORKSPACE`, `PHI_HOME`, `PHI_CREDENTIAL_MODE` (`native` by default), `PHI_CONCURRENCY` (default `4`), `PHI_CURSOR_MODEL`, `PHI_CLAUDE_MODEL`, `PHI_CODEX_MODEL`, and `PHI_COORDINATOR_MODEL`. Comma-separated `PHI_CURSOR_MODELS`, `PHI_CLAUDE_MODELS`, and `PHI_CODEX_MODELS` define host-approved per-job choices. Cursor is deliberately restricted to Grok and Composer; its built-in catalog is `grok-4.6`, `grok-4.5`, `composer-2.5`, and `composer-2`, with `composer-2.5` as the default.

## Verification

```sh
bun run format:check
bun run typecheck
bun run test
bun run spike
```

Tests create separate temporary workspaces and runtime directories. The suite does not make authenticated network calls or consume model quota. See [docs/adapters.md](docs/adapters.md) for exact SDK versions and capability boundaries, and [docs/spec.md](docs/spec.md) for durable state and recovery semantics.

## Direction: channels, threads, and the server

Phi is evolving from a TUI into a durable server powering Slack-like GUI clients (channels → threads → messages). Design decisions, rationale, and the migration sequence are recorded in [docs/channels-and-server.md](docs/channels-and-server.md).

## Security boundary

The Pi coordinator receives only Phi's restricted coordination/read tools. Worker adapters are different: a working directory and prompt instruction are **not** a sandbox. Cursor and Claude workers can execute with the authority of their SDK process. Codex is configured with its official read-only or workspace-write sandbox mode and `approvalPolicy: "never"`, but Phi does not claim that this creates a stronger host security boundary than the SDK provides. Run Phi only against a workspace and credentials you intend those workers to access.
