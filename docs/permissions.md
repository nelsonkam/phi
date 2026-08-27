# Agent Permission Prompts

Status: Draft (design decisions, not yet implemented)
Depends on: [channels-and-server.md](./channels-and-server.md) §5, [multi-agent.md](./multi-agent.md) §1

When a harness wants to run a tool it asks its client for permission over ACP
(`session/request_permission`). Phi currently auto-approves everything:
`approvePermission()` in `src/core/agents/runtime.ts` picks the first
`allow_once`/`allow_always` option and answers immediately. That suits
unattended agents but gives the user no visibility into — or control over —
what agents do to the workspace.

This document specifies per-agent permission policies with three modes, and the
interactive prompt UI that two of them depend on. The prompt is the foundation:
**a permission request becomes a message in the thread**, rendered with
Allow/Reject buttons, resolved by a REST call that unblocks the waiting
harness. Modes are a policy layer routing requests either straight to an
answer or into that prompt.

## 1. Summary of decisions

| Topic | Decision |
| ----- | -------- |
| Modes | `ask` (always prompt), `auto` (LLM triage: approve or escalate to prompt), `allow` (current auto-approve) |
| Mode location | `permissions:` key in agent frontmatter; workspace default is `ask` |
| Request representation | A `messages` row, `author: system`, `kind: permission_request`, full detail in `metadata.permission`; no new table, no migration |
| Blocking model | The ACP handler awaits a deferred promise keyed by message id; the turn stays active until the user (or the auto judge) answers. No timeout — consistent with the untimed `session/prompt` |
| Resolution transport | `POST /api/v1/threads/:id/permissions/:messageId`; a new `message.updated` ServerFrame carries the resolved state to clients |
| Restart / teardown | Pending rows swept to `stale` on boot (alongside `recoverInterruptedTurns`) and on session/host death; deferreds resolved as `cancelled` |
| Auto judge | Haiku via `@anthropic-ai/sdk`; verdict is `approve` or `escalate`, never deny — denying is a human call |
| Auto failure posture | Fail closed to the human: LLM error, timeout, or missing API key degrades `auto` to `ask`, never to `allow` |
| Agent transcripts | `permission_request` rows are excluded from catch-up context; prompts never re-enter harness transcripts |
| Audit trail | Auto-approved requests still write a (pre-resolved) `permission_request` row annotated with the judge's reason |

## 2. The prompt flow (`ask` mode, and `auto` escalations)

### 2.1 Runtime

`AcpClientHandlers.onRequestPermission` (src/core/agents/acp-process.ts)
becomes `MaybePromise`-returning — the ACP SDK's `ClientRequestHandler`
already allows it; today's synchronous signature is a local narrowing.

In `startHost()`, the bare `onRequestPermission: approvePermission` becomes a
closure that resolves the session like its `onSessionUpdate` sibling
(`host?.sessionsById.get(request.sessionId)`; `ThreadSession` gains a
`threadId` field) and dispatches on the agent's mode. For `ask`:

1. Append a `permission_request` row (§3) with `state: "pending"`.
2. Register `{ resolve, threadId, sessionId }` in a new
   `pendingPermissions: Map<messageId, …>` on `AgentRuntime`.
3. Return the promise. The harness blocks inside its `session/prompt`; the
   thread's turn indicator keeps showing the agent as working.

An unknown `sessionId` answers `{ outcome: { outcome: "cancelled" } }`.

A new public `resolvePermission(threadId, messageId, choice)` — where `choice`
is `{ optionId }` or `{ cancelled: true }` — validates that the row exists in
that thread, is still pending, and that `optionId` is one of the offered
options; updates the metadata to `resolved`; resolves and deletes the
deferred. It returns a discriminated result (`ok | not_found |
already_resolved | bad_option`) so the route maps cleanly to 200/404/409/400.

Cleanup: `dropSessionByKey`, host `proc.exited`, and `close()` resolve that
scope's outstanding deferreds as cancelled and mark their rows `stale`.
`recoverInterruptedTurns()` sweeps any pending rows to `stale` on boot — a
live ACP request cannot outlive the process, same as a live turn.

`catchUpContext()` skips `kind === "permission_request"` rows.

### 2.2 Store and wire

- `StoreChange` and `ServerFrame` gain `message.updated` (carrying the full
  `Message`). `updateMessageMetadata()` re-reads the row and emits it — today
  it writes silently, which would leave resolution invisible to clients. The
  only other subscriber (`MessageSearch`) filters on `message.appended` and is
  unaffected.
- New store helpers: `getMessage(id)` and
  `listPendingPermissionMessages(workspaceId)` (via
  `json_extract(metadata_json, '$.permission.state') = 'pending'`).
- `applyServerFrame` (src/web/lib/queries.ts) handles `message.updated` by
  replacing the message by id in the thread's cache, invalidating if absent.

### 2.3 Server and client

- Route: `POST /api/v1/threads/:id/permissions/:messageId`, a thin adapter
  over `runtime.resolvePermission` modeled on the `/retry` route. The
  WebSocket stays server→client only.
- Client: `resolvePermission()` in src/web/lib/api.ts,
  `useResolvePermission(threadId)` mutation in queries.ts.

### 2.4 UI

New `src/web/components/permission-prompt.tsx`, rendered from
`thread-panel.tsx` as `MessageItem` children when
`kind === "permission_request"` — the `RetryTurnButton` pattern. States:

- **Pending**: tool title, ACP `kind` badge, truncated `rawInput` summary; one
  button per offered option — allow kinds primary, reject kinds secondary;
  buttons disabled while the mutation is in flight. Escalated requests show
  the judge's reason line.
- **Resolved**: which option was chosen (or "auto-approved: <reason>").
- **Stale**: muted "expired" note.

The channel view needs no change: thread roots are always user messages, and
`channel.tsx` already swallows button clicks inside thread roots.

## 3. Message shape

```jsonc
{
  "author": "system",
  "kind": "permission_request",
  "content": "researcher requests permission: Edit src/index.ts", // search/fallback text
  "metadata": {
    "permission": {
      "agent": "researcher",
      "toolCall": { "toolCallId": "…", "title": "Edit src/index.ts", "kind": "edit", "rawInput": { /* truncated ~2KB */ } },
      "options": [ { "optionId": "…", "name": "Allow", "kind": "allow_once" }, … ],
      "state": "pending", // | "resolved" | "stale"
      "selectedOptionId": null,
      "cancelled": false,
      "decidedBy": null, // "user" | "auto" once resolved
      "autoReason": null // judge's one-liner when auto mode touched it
    }
  }
}
```

`rawInput` is truncated before storing — it can be large and may contain
sensitive content.

## 4. Modes

`permissions: ask | auto | allow` joins the agent frontmatter schema
(src/core/agents/registry.ts `FrontmatterSchema`). Unset falls back to the
workspace default, `ask`. This is a phi-level policy, distinct from
harness-advertised config options like Claude Code's permission mode — those
control whether requests are *emitted*; this controls how phi *answers* them.

- **`allow`** — today's `approvePermission()`: pick `allow_once` over
  `allow_always` (per-call approval keeps the door open for later tightening),
  else cancel. No prompt row is written.
- **`ask`** — every request goes through §2.
- **`auto`** — triage, then either answer or escalate into §2:
  1. *Rule pre-filter*: ACP tool-call `kind`s that are read-only (`read`,
     `fetch` of local state, etc.) approve immediately — no model call.
  2. *LLM judge*: Haiku (via `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY` from the
     environment) sees the tool call (`title`, `kind`, `rawInput`) plus the
     agent name, and returns structured `{ verdict: "approve" | "escalate",
     reason }`. Approve answers `allow_once` and writes a pre-resolved row
     (`decidedBy: "auto"`, `autoReason`) for the audit trail. Escalate enters
     the prompt flow with the reason surfaced in the UI.
  3. *Fail closed*: judge error, ~5s timeout, or no API key → escalate. Auto
     degrades to ask, never to allow. The judge never denies.

## 5. Edge cases

- **User never answers** — turn stays active; later user messages queue on the
  existing per-thread chain. Acceptable for v1; no timeout.
- **Restart mid-prompt** — row goes `stale` via the boot sweep; the harness
  side of the request died with the process, and session resume handles the
  turn as it does today.
- **Duplicate clicks / two tabs** — optimistic disable client-side; the
  endpoint is idempotent-hostile by design (second resolve → 409) and the
  `message.updated` frame converges both tabs.
- **Retry while pending** — cannot race: `/retry` 409s while `turnActive`.
- **Multiple agents / multiple prompts** — deferreds are keyed by message id;
  nothing assumes one pending request per thread.
- **Harness reaction to reject/cancel** — varies by harness (graceful
  continue vs. abrupt turn end); the existing error-message path covers abrupt
  ends. Verify against real claude-code during implementation.

## 6. Sequencing

1. **Ask flow end-to-end** (§2–§3): runtime deferreds, store/wire changes,
   endpoint, prompt UI. Ship with `ask` as the only prompting mode and
   `allow` preserved for existing setups.
2. **Policy layer** (§4 minus the judge): frontmatter key, workspace default,
   mode dispatch in the handler.
3. **Auto judge**: SDK dependency, pre-filter, structured verdict, audit rows,
   fail-closed degradation.

## 7. Test plan

- **Runtime** (`runtime.test.ts`, `fixture({ agentArgs: ["permission"] })`):
  the fake ACP agent gains a client-bound request sender (request-id
  allocator + pending-response map; a stdin line with `id` and no `method` is
  a response) and a `permission` mode that requests permission on prompt,
  reports the outcome via MCP `send_message`, and ends the turn. Tests poll
  `store.listMessages` for the pending row — `settled()` cannot resolve while
  the prompt blocks. Cover: allow, reject, cancelled, 409 on double-resolve,
  bad `optionId` leaves the deferred intact, `close()` marks pending rows
  stale, boot sweep, catch-up exclusion, and each mode's dispatch (judge
  stubbed via an injected `judgePermission` option).
- **Store** (`store.test.ts`): `updateMessageMetadata` emits
  `message.updated`; `getMessage`; the pending-permission query.
- **Manual**: real claude-code agent with a prompting permission mode →
  prompt renders; Allow proceeds and the row resolves live in a second tab;
  restart mid-prompt shows stale; Deny path; `auto` mode approves a read and
  escalates a shell command.
