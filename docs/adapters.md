# Worker adapter capabilities

Phi pins and directly imports these official SDK releases:

| Adapter | Package                          | Exact version |
| ------- | -------------------------------- | ------------- |
| Cursor  | `@cursor/sdk`                    | `1.0.28`      |
| Claude  | `@anthropic-ai/claude-agent-sdk` | `0.3.241`     |
| Codex   | `@openai/codex-sdk`              | `0.149.0`     |

The lockfile also pins Pi coordinator packages at `0.84.2`. Bun 1.3.12 import checks, strict TypeScript compilation, and credential-free adapter conformance tests pass for these exact versions. Authenticated service calls are opt-in and are not part of `bun run test`.

## Capability matrix

| Capability             | Fake                      | Cursor                                                                | Claude                                                                        | Codex                                                                     |
| ---------------------- | ------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Progress/watch         | Live deterministic events | Live SDK stream                                                       | Live SDK query stream                                                         | Live thread event stream                                                  |
| Continuation           | Active `needs_input`      | Sequential agent sends                                                | SDK supports resumed sequential sessions; Phi active follow-up is unsupported | SDK supports sequential thread turns; Phi active follow-up is unsupported |
| Cancellation           | Live abort                | Attached run or persisted local run ID                                | Live `Query`/`AbortController` only                                           | Live turn `AbortSignal` only                                              |
| Restart reconciliation | Dispatch key or run ID    | Persisted local run ID; dispatch-key-only ambiguity becomes `unknown` | No authoritative interrupted-query lookup                                     | No authoritative interrupted-turn lookup                                  |
| Reasoning              | Synthetic summary events  | Official `thinking` text only                                         | None captured                                                                 | Official reasoning-summary item text only                                 |
| Tool activity          | Synthetic                 | Official tool call/status events                                      | Official tool use/progress/summary events                                     | Official command/file/MCP/web/todo items                                  |
| Worker asks for input  | Yes                       | No normalized SDK primitive                                           | No normalized SDK primitive                                                   | No normalized SDK primitive                                               |
| Isolation claim        | None                      | None                                                                  | None                                                                          | Official SDK sandbox mode only                                            |

Phi never requests or stores private chain-of-thought. It records only assistant text, tool/status/usage activity, and reasoning or thinking summary fields that an official SDK exposes as observable output.

## Cursor

Phi uses the Bun-compatible bundled entry point and a `JsonlLocalAgentStore` under `~/.phi/sessions/workers/cursor`. Launch uses a host-derived dispatch idempotency key. A persisted external run ID can be reopened and its stream reattached after restart. A crash before Phi durably records that run ID cannot be reconciled from the dispatch key and is marked `unknown`.

In the default native credential mode, Phi omits an explicit SDK key so the SDK can use `CURSOR_API_KEY` or its existing user login store. Isolated mode accepts `CURSOR_API_KEY` or `~/.phi/credentials/cursor-api-key` and does not fall back to the native login store.

Cursor sequential `agent.send()` is available while the agent remains attached, but Cursor does not emit Phi's active `needs_input` event. Therefore the durable `/follow` flow is not advertised for Cursor jobs. Local `cwd`, prompt warnings, and disabled ambient setting sources are not a sandbox.

## Claude

Phi uses the Agent SDK `query()` stream with Bun as the SDK executable, no project/local/user setting sources, automatic memory disabled, and an abort controller. In native credential mode it leaves `CLAUDE_CONFIG_DIR` unset so Claude Code can reuse its environment, Keychain, or user-home login. Isolated mode points `CLAUDE_CONFIG_DIR` below `~/.phi/credentials` and accepts `ANTHROPIC_API_KEY` or `~/.phi/credentials/anthropic-api-key`. Claude's SDK may still read its documented global configuration in native mode. Tool use, tool progress, assistant text, result, cost, and usage are normalized. Private model thinking is not captured.

The adapter currently uses `bypassPermissions` with the SDK's explicit dangerous opt-in so an unattended worker can act on the shared workspace. This is unrestricted host authority, not isolation. Cancellation is reliable only while the live `Query` object exists. The SDK can resume a session for a later sequential turn, but it cannot authoritatively inspect an interrupted active query by Phi dispatch key; ambiguous recovery becomes `unknown`.

## Codex

Phi starts an SDK thread in the shared working directory with `approvalPolicy: "never"`. Read-only jobs request `sandboxMode: "read-only"`; mutating jobs request `sandboxMode: "workspace-write"`. Assistant messages, official reasoning summaries, commands, file changes, MCP calls, web searches, todos, failures, and usage are normalized.

Native credential mode leaves `CODEX_HOME` unchanged, reusing the Codex CLI/IDE login and user configuration. Isolated mode sets `CODEX_HOME` below `~/.phi/credentials/codex` and accepts `OPENAI_API_KEY` or `~/.phi/credentials/openai-api-key`. Because Codex stores configuration as well as authentication beneath `CODEX_HOME`, native mode deliberately shares that user-level configuration; it is not credential-only mounting.

Cancellation uses the live turn's abort signal. The SDK can resume a thread for a new sequential turn, but does not expose authoritative lookup of whether an interrupted turn completed. Phi therefore marks such recovery as `unknown` instead of inventing an outcome. SDK sandboxing is reported as an SDK capability, not as a Phi-enforced security boundary.

## Deterministic fake

The fake adapter is the conformance reference and default credential-free worker. Task markers select deterministic behavior: `[fake:delay=N]`, `[fake:needs_input]`, `[fake:fail]`, and `[fake:duplicate]`. It implements live progress, in-run follow-up, cancellation, dispatch-key reconciliation, and intentional duplicate terminal delivery for dedupe testing.
