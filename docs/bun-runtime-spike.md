# Bun Runtime Spike

Status: Passed  
Run date: 2026-08-23  
Host: macOS arm64

## Decision

Use Bun for the Phi host and `bun:sqlite` for `~/.phi/runtime.db`.

The validated baseline is:

| Component                         | Version |
| --------------------------------- | ------- |
| Bun                               | 1.3.12  |
| `@earendil-works/pi-coding-agent` | 0.84.2  |
| `@earendil-works/pi-ai`           | 0.84.2  |
| `typebox`                         | 1.3.7   |

The executable spike is in [`spikes/bun-runtime`](../spikes/bun-runtime/). Run it with:

```sh
cd spikes/bun-runtime
bun install
bun run spike
```

## What passed

### `bun:sqlite`

- Created and reopened an on-disk database.
- Enabled WAL, foreign keys, `synchronous = NORMAL`, and a busy timeout.
- Created `STRICT` tables with a foreign key and unique dispatch key.
- Committed a `BEGIN IMMEDIATE` transaction.
- Rejected a duplicate semantic dispatch key.
- Rolled back a failed transaction.
- Preserved committed data across close and reopen.

### Pi SDK under Bun

- Imported `createAgentSession` and `InteractiveMode` from the published package.
- Created an explicit `ModelRuntime`, persistent `SessionManager`, settings manager, and restricted resource loader.
- Disabled Pi's built-in coding tools and registered one Phi-style custom tool.
- Ran a complete credential-free agent/tool loop using Pi's deterministic faux provider.
- Observed `tool_execution_start`, `tool_execution_end`, and `agent_settled` events.
- Persisted the prompt, tool call, tool result, and final response to Pi JSONL.
- Reopened the same JSONL with `SessionManager.continueRecent` and restored its message history.
- Disposed the session cleanly.
- Ran the published Pi CLI entry point with Bun and received version 0.84.2.

## Boundaries not proven

- Pi's interactive TUI was imported as a compatibility probe but is not used by Phi. Phi now owns its OpenTUI/Solid terminal interface and keeps Pi headless.
- No live model provider, OAuth flow, MCP server, shell tool, image path, or compaction flow was exercised.
- The MVP subsequently import- and type-validated the official Cursor SDK 1.0.28, Claude Agent SDK 0.3.241, and Codex SDK 0.149.0 directly under Bun 1.3.12. Phi therefore uses SDK integration rather than CLI-output scraping. Authenticated network behavior is deliberately outside this credential-free spike and remains an opt-in smoke test.
- Pi 0.84.2 declares `engines.node >= 22.19.0`; it does not advertise Bun as a supported runtime. Compatibility is therefore measured, not guaranteed upstream.

## Packaging observation

Bun blocked two transitive lifecycle scripts during installation:

- `@google/genai`: a no-op preinstall script.
- `protobufjs`: its postinstall script.

The spike passed without trusting either script. Keep installs locked and non-interactive; only add packages to Bun's trusted dependency list if a tested feature proves that its lifecycle output is required.

## Upgrade gate

Run this spike in CI on the target macOS and Linux environments whenever Bun or Pi changes. Keep the Phi-owned TUI interaction test and a persistent-session resume test as separate upgrade gates.
