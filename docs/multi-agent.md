# Multi-Agent Interactions

Status: Draft (design decisions, not yet implemented)
Depends on: [channels-and-server.md](./channels-and-server.md) §3, §5, [mcp-tools.md](./mcp-tools.md) §4, §6

Phi threads currently bind exactly one agent: `thread_sessions` keys on
`thread_id`, and `AgentRuntime` routes every user message in a thread to that
agent (or the default). This document records how phi grows from that to
multiple agents interacting — with the user and with each other — without
abandoning the invariants that make the current design durable.

The core move is a generalization, not a new architecture: **multiple harness
sessions over one shared thread log, routed by @-mention, serialized per
thread**. An agent's private context is its harness session; the shared truth
between agents is the thread's `messages` table; an interaction between agents
is one agent posting a message that names another, and phi scheduling a turn
for the named agent with the transcript it hasn't seen.

## 1. Summary of decisions

| Topic | Decision |
| ----- | -------- |
| Interaction medium | The durable thread message log; agents never communicate off-log |
| Session binding | `(thread_id, agent_name)` — one harness session per agent per thread |
| Routing | User messages: leading `@name` only (else the thread default). Agent handoff: explicit `to` on `send_message`. Mid-message @-names are not recipients |
| Turn-taking | One turn at a time per thread, regardless of agent; the existing per-thread promise chain, made agent-aware |
| Shared context | Per-`(thread, agent)` catch-up: transcript delta since the agent's last turn, prefixed to the prompt (generalizes `recoveryContext`) |
| Loop prevention | Hop budget on consecutive agent-triggered turns; reset by user messages; an agent cannot enqueue itself |
| Author model | `MessageAuthor` collapses to `user \| agent \| system`; agent name lives in metadata |
| Delegation | Deferred phase 2: child threads, not hidden channels or a job system |
| Router/coordinator agent | Rejected as architecture; available later as an ordinary persona users mention |

## 2. Why the thread log is the medium

The load-bearing invariant from channels-and-server.md §5 and §11 is that the
durable message read model is authoritative and harness sessions are caches —
that is what makes `session/resume`, `session/load`, and transcript recovery
interchangeable in `ensureSession`. Multi-agent falls out of taking the same
invariant seriously:

- Each agent's *private* context (its reasoning, its tool calls, its working
  state) stays in its own harness session, exactly as today.
- Everything agents need to share flows through `messages`, which is already
  durable, sequenced (`seq`), broadcast to clients, and recoverable.
- Because every inter-agent exchange is an ordinary message, the interaction
  is fully auditable in the UI. There is no hidden coordination channel to
  instrument, persist, or explain.

This is also exactly the mental model the Slack-like UI already teaches:
people and agents in a thread, taking turns, addressing each other by handle.
The `Agent` type has anticipated this since its introduction — the name
"doubles as the @-mention handle."

## 3. Session binding: `(thread_id, agent_name)`

Migration 003 keys `thread_sessions` on `thread_id` alone. Migration 005
re-keys it on `(thread_id, agent_name)`:

```sql
CREATE TABLE thread_agent_sessions (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  model TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_seen_seq INTEGER NOT NULL DEFAULT 0,   -- catch-up cursor, §6
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, agent_name),
  UNIQUE (harness_id, session_id)
);
```

Backfill is mechanical: every existing row becomes `(thread_id, agent_name)`
with `last_seen_seq = threads.last_seq` (the bound agent has seen everything
in its own session history).

`AgentRuntime.sessions` keys on the same pair. Each live session keeps its own
ACP process and its own MCP token; the token already maps to
`{ threadId, agentName }` (mcp-tools.md §4), so `send_message` attribution,
turn accounting, and revocation need no changes.

A thread still has a *default* agent: the agent its root message routed to
(the leading mention when there was one, else the workspace default). It is
derived from the root message's durable routing metadata, not stored
separately; unmentioned replies route to it, and if that agent has since been
deleted the fallback degrades to the workspace default. Additional agents
join a thread lazily, the first time they are a routing target (leading
`@name` or `to`); joining is nothing more than creating their session
binding. Mid-body name drops do not join anyone.

## 4. Routing: mentions decide who turns next

A message triggers a turn for the agents it addresses:

- **User messages**: only a leading `@name` (after optional whitespace) is
  an address. If it matches the registry, that agent gets the turn; anything
  else `@mentioned` later in the body is ordinary text. No leading mention
  routes to the thread's default agent — the current behavior is the
  fallback, so single-agent threads work exactly as today.
- **Agent messages**: `send_message` gains an optional `to` parameter
  (a list of agent names) for deliberate handoff. If `to` is omitted, the
  same leading-`@name` heuristic applies. Mid-body mentions never route, so
  an agent quoting "@architect suggested X" does not summon the architect.
  No `to` and no leading mention means no turn — the message is a statement
  in the log, not a ping.
- `to` with multiple names enqueues one turn per recipient, in list order,
  on the same thread chain (§5). A user message still routes to at most one
  agent (the leading mention, or the default).

This is the v1 heuristic: addressing looks like Slack (`@architect draft
the plan, then have @implementer start` wakes architect only). Waking two
agents from one user message is out of scope until we need it.

Parsing is server-side and validates against the registry: an unknown
`@name` is inert text, never an error — including a leading `@name` that
matches nobody, which then falls through to the default agent. Routing
metadata (`mentions`, `routedTo`) is recorded on the message row for
display and debugging.

The host, not a model, performs routing. This keeps routing deterministic,
free, and user-legible: the user can always tell why an agent responded by
looking at the leading mention (or `to`) on the message that named it.

## 5. Turn-taking: per-thread serialization, agent-aware

The per-thread promise chain in `AgentRuntime` survives unchanged in shape:
**one turn at a time per thread, regardless of which agent is turning.** Two
agents can never talk over each other in one thread, `turnAgent` continues to
tell clients exactly who is typing, and the `pendingTurns` counter continues
to present chained turns as one continuous working state.

What changes is what enters the chain. Today only user messages enqueue
turns. Now a turn is enqueued for each routed recipient of a committed
message, whoever authored it:

```text
user: "@architect draft the plan, then have @implementer start"
  └── turn: architect
        └── architect send_message(to: [implementer], "Plan is in ...")
              └── turn: implementer          (same chain, after architect settles)
```

Parallelism stays where channels-and-server.md put it: across threads and
channels, never within a thread. If two agents should genuinely work
concurrently, that is two threads — which the child-thread delegation model
(§9) makes first-class later.

Recovery (`recoverInterruptedTurns`) is unchanged: an active persisted turn
at startup still means the process died mid-turn; the flag is cleared and the
interruption surfaced. Queued-but-unstarted agent turns are not persisted and
die with the process; the message that would have triggered them remains in
the log, and the user can address them again. Durable turn queues are
deferred until this proves annoying in practice.

## 6. Catch-up context replaces shared context

When agent B takes its first turn in a thread where the user and agent A have
been talking, B's harness session has seen none of it. Phi already solved
this exact problem for crash recovery: `recoveryContext` replays the durable
log into a fresh session, bounded and framed. Multi-agent generalizes it:

- `thread_agent_sessions.last_seen_seq` records the highest `seq` each agent
  has been shown (advanced when its turn settles).
- Every turn's prompt is prefixed with the transcript delta
  `last_seen_seq < seq < currentMessage.seq`, rendered as
  `[user]: ...` / `[@architect]: ...` lines, bounded by the same
  `RECOVERY_CONTEXT_MAX_CHARS` cap (most recent suffix wins).
- The framing text mirrors the recovery preamble: prior conversation, do not
  answer it independently, continue with the routed message.

For the single-agent thread this is a no-op — the delta is empty because the
agent sees every message as it arrives — so the current fast path is
untouched. Crash recovery becomes a special case of catch-up rather than a
separate mechanism.

Agents are told, in the messaging preamble, that other agents' messages are
peers' contributions in a shared thread: address them by handle, do not
impersonate them, and do not assume their tool results without reading the
log.

## 7. Loop prevention: the hop budget

Handoff between agents — `to` on `send_message`, or a leading `@name` on an
agent message — can ping-pong indefinitely: A thanks B, B acknowledges A,
forever, at full token cost. Mid-body name drops do not cause this; the
handoff paths do. The one genuinely new safety rule this design introduces:

- A **hop** is a turn triggered by an agent message. The per-thread hop
  counter increments on each hop and resets to zero on any user message.
- When a routed turn would exceed the budget (default **4**), it is not
  enqueued. Phi posts a system message instead: the exchange is paused and
  names who was next, so the user can continue it with one message.
- An agent cannot enqueue its own next turn. `to` or a leading `@` that
  names the author is ignored.
- The budget is a host-enforced invariant, not a prompt instruction.

Four hops covers the useful shapes (hand-off, question, answer, confirmation)
while making runaway loops structurally impossible. It can become
configurable per workspace if real usage wants longer chains.

## 8. Author model cleanup

`MessageAuthor`'s `coordinator | worker` split is a fossil of spec.md's
architecture; the gui branch launches agents directly and stores the agent
name in message metadata already. With multiple peer agents the role split is
actively wrong, so it collapses:

```ts
export type MessageAuthor = "user" | "agent" | "system";
```

The agent name in `metadata.agent` becomes required for `author: "agent"`
rows and drives avatar/handle rendering. Existing `coordinator`/`worker` rows
are migrated to `agent`. Attribution follows the persona rule from
channels-and-server.md §8: the name is reference data, never a foreign key —
deleting an agent file must not break history rendering.

## 9. Deferred: delegation as child threads

Sometimes an agent should farm out work that would clutter the thread —
long-running, noisy, or parallel. That is **not** a reason for off-log
messaging; it is a reason for a **child thread**:

- Agent A calls a `spawn_thread` tool: phi creates a thread (same channel,
  `parent_thread_id` set) bound to agent B, seeded with A's brief.
- B works in the child thread with its own turn chain — this is where true
  intra-request parallelism comes from, on infrastructure threads already
  have (serialization, sessions, recovery, settle/archive).
- When the child settles, phi posts one result message into the parent,
  routed back to A. The child remains linked and inspectable, so the detail
  is a click away instead of inline noise.

This is spec.md's coordinator/worker job model reborn on thread
infrastructure — same persist-intent-before-effect shape, no new job tables —
and it is phase 2. In-thread mentions must work first, because child threads
reuse their routing, catch-up, and budget machinery.

## 10. Rejected alternatives

- **A router/coordinator agent deciding who responds.** spec.md's
  coordinator earned its keep by owning jobs, obligations, and delivery. As a
  pure message router it adds a model call, latency, cost, and an opaque
  decision to every message, where mentions are deterministic and free. A
  triage persona that users *choose* to mention is a usage pattern, not
  architecture, and needs no support beyond this design.
- **Broadcast: every agent sees every message and decides whether to reply.**
  N harness turns burned per message, non-deterministic pile-on replies, and
  no way for the user to predict who will answer. This is the default shape
  of most multi-agent frameworks and the wrong one for a tool.
- **Direct agent-to-agent channels invisible to the user.** Breaks the
  durable-log-is-truth invariant and the audit trail in one move; every
  hidden exchange would need its own persistence, recovery, and display
  story. Child threads (§9) give the same decluttering with none of the
  opacity.
- **Concurrent turns within one thread.** Two agents interleaving bubbles in
  one conversation is unreadable, and per-agent turn locks would reintroduce
  the cross-talk `turnAgent` exists to prevent. Threads are cheap; concurrency
  belongs between them.
- **Session-per-thread shared by all agents (one session, many personas).**
  Prompt-switching one harness session between personas bleeds context and
  identities and breaks per-agent model/config choices. Per-`(thread, agent)`
  sessions keep identity, model, and config where agents already define them.

## 11. Implementation sequence

1. Author model collapse (`user | agent | system`) and metadata migration —
   independent of everything else, shrinks later diffs.
2. Migration 005: `thread_agent_sessions` keyed on `(thread_id, agent_name)`
   with `last_seen_seq`; re-key `AgentRuntime.sessions`; single-agent threads
   behave identically.
3. Catch-up context: per-agent cursor, delta rendering, recovery unified onto
   it.
4. Leading-`@name` routing for user messages; agents join threads on first
   routing target (leading mention or `to`), not on mid-body name drops.
5. `send_message` `to` parameter, agent-triggered turns, and the hop budget —
   this step turns on agent-to-agent interaction.
6. UI: mention autocomplete in the composer, per-agent avatars/handles,
   routing metadata on hover.
7. Later: child-thread delegation (§9), durable turn queues if interrupted
   handoff chains prove annoying, per-workspace hop budget configuration.
