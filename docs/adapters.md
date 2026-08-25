# Worker adapter capabilities

Phi pins and directly imports these official SDK releases:

| Adapter | Package                          | Exact version |
| ------- | -------------------------------- | ------------- |
| Cursor  | `@cursor/sdk`                    | `1.0.28`      |
| Claude  | `@anthropic-ai/claude-agent-sdk` | `0.3.241`     |
| Codex   | `@openai/codex-sdk`              | `0.149.0`     |

The lockfile also pins Pi coordinator packages at `0.84.2`. Bun 1.3.12 import checks, strict TypeScript compilation, and credential-free adapter conformance tests pass for these exact versions. Authenticated service calls are opt-in and are not part of `bun run test`.

The Phi-owned TUI pins `@opentui/core` and `@opentui/solid` at `0.5.7` with their exact `solid-js` peer at `1.9.12`. Pi remains the headless coordinator/session engine; it no longer owns the terminal presentation.

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
| Root model selection   | Deterministic built-in    | Per job; Grok/Composer allowlist                                      | Per job; documented aliases and configured IDs                                | Per job when IDs are host-configured                                      |
| Reasoning effort       | None                      | No common SDK effort field                                            | `low` through `max`, model permitting                                         | `minimal` through `ultra`, model permitting                               |
| Model scope            | Entire run                | Root agent                                                            | Root query; nested agents may differ                                          | Root thread                                                               |
| Web search             | None                      | Not claimed                                                           | SDK-managed                                                                   | SDK-managed                                                               |

Phi never requests or stores private chain-of-thought. It records only assistant text, tool/status/usage activity, and reasoning or thinking summary fields that an official SDK exposes as observable output.

## Cursor

Phi uses the Bun-compatible bundled entry point and a `JsonlLocalAgentStore` under `~/.phi/sessions/workers/cursor`. Launch uses a host-derived dispatch idempotency key. A persisted external run ID can be reopened and its stream reattached after restart. A crash before Phi durably records that run ID cannot be reconciled from the dispatch key and is marked `unknown`.

In the default native credential mode, Phi uses an explicit in-process key obtained by its login action when present, then `CURSOR_API_KEY`, then the Cursor SDK's own login store. The SDK store is normally `~/.cursor/sdk/auth.json`; it is separate from the Cursor desktop application's authentication and cannot reuse that desktop login. Run `doctor` to see readiness, then use **Ctrl+P → Log in to Cursor** in the Phi TUI when login is required. The official SDK browser flow writes the SDK store; Phi never copies or prints the returned key. A stale `CURSOR_API_KEY` precedes the stored login until it is removed or corrected. Isolated mode accepts `CURSOR_API_KEY` or `~/.phi/credentials/cursor-api-key`, does not fall back to the native login store, and disables interactive browser login.

Cursor sequential `agent.send()` is available while the agent remains attached, but Cursor does not emit Phi's active `needs_input` event. Therefore the durable `/follow` flow is not advertised for Cursor jobs. Local `cwd`, prompt warnings, and disabled ambient setting sources are not a sandbox.

Phi intentionally offers only the SDK-validated Cursor families requested for this harness: `grok-4.6`, `grok-4.5`, `composer-2.5`, and `composer-2`. `PHI_CURSOR_MODEL` chooses the default and must remain in the Grok or Composer families; `PHI_CURSOR_MODELS` may narrow the selectable set but cannot introduce another family. Cursor's SDK accepts the selected model when the root agent is created. Phi does not claim control over any provider-managed nested model.

## Claude

Phi uses the Agent SDK `query()` stream with Bun as the SDK executable, no project/local/user setting sources, automatic memory disabled, and an abort controller. In native credential mode it leaves `CLAUDE_CONFIG_DIR` unset so Claude Code can reuse its environment, Keychain, or user-home login. Isolated mode points `CLAUDE_CONFIG_DIR` below `~/.phi/credentials` and accepts `ANTHROPIC_API_KEY` or `~/.phi/credentials/anthropic-api-key`. Claude's SDK may still read its documented global configuration in native mode. Tool use, tool progress, assistant text, result, cost, and usage are normalized. Private model thinking is not captured.

The adapter currently uses `bypassPermissions` with the SDK's explicit dangerous opt-in so an unattended worker can act on the shared workspace. This is unrestricted host authority, not isolation. Cancellation is reliable only while the live `Query` object exists. The SDK can resume a session for a later sequential turn, but it cannot authoritatively inspect an interrupted active query by Phi dispatch key; ambiguous recovery becomes `unknown`.

Claude accepts a root model and effort per query. Phi advertises the SDK-documented `haiku`, `sonnet`, `opus`, and `fable` family aliases plus `PHI_CLAUDE_MODELS`; account availability is ultimately checked by Claude Code at launch. The selected root model is durable, but Claude-managed nested agents may use different models, so Phi reports model scope honestly as `root`.

## Codex

Phi starts an SDK thread in the shared working directory with `approvalPolicy: "never"`. Read-only jobs request `sandboxMode: "read-only"`; mutating jobs request `sandboxMode: "workspace-write"`. Assistant messages, official reasoning summaries, commands, file changes, MCP calls, web searches, todos, failures, and usage are normalized.

Native credential mode leaves `CODEX_HOME` unchanged, reusing the Codex CLI/IDE login and user configuration. Isolated mode sets `CODEX_HOME` below `~/.phi/credentials/codex` and accepts `OPENAI_API_KEY` or `~/.phi/credentials/openai-api-key`. Because Codex stores configuration as well as authentication beneath `CODEX_HOME`, native mode deliberately shares that user-level configuration; it is not credential-only mounting.

Cancellation uses the live turn's abort signal. The SDK can resume a thread for a new sequential turn, but does not expose authoritative lookup of whether an interrupted turn completed. Phi therefore marks such recovery as `unknown` instead of inventing an outcome. SDK sandboxing is reported as an SDK capability, not as a Phi-enforced security boundary.

Codex accepts a root model and `modelReasoningEffort` per thread, but this SDK release has no model-catalog API. Phi therefore advertises only IDs configured through `PHI_CODEX_MODELS`; omitting that variable leaves the provider/CLI default as the only choice. The adapter preserves the last official agent message as the terminal summary instead of reducing successful work to a generic completion marker.

## Deterministic fake

The fake adapter is the conformance reference and default credential-free worker. Task markers select deterministic behavior: `[fake:delay=N]`, `[fake:needs_input]`, `[fake:fail]`, and `[fake:duplicate]`. It implements live progress, in-run follow-up, cancellation, dispatch-key reconciliation, and intentional duplicate terminal delivery for dedupe testing.
