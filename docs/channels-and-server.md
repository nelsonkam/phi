# Channels, Threads, and the Server Architecture

Status: Draft (design decisions, not yet implemented)
Supersedes parts of [spec.md](./spec.md) §5.4, §6.2, §9 where noted

Phi is evolving from a local TUI application into a durable server that powers
GUI clients (desktop and mobile) presenting a Slack-like interface:
**channels → threads → messages**. This document records the architecture
decisions made for that evolution, their rationale, and the rejected
alternatives, so implementation does not relitigate them.

## 1. Summary of decisions

| Topic | Decision |
| ----- | -------- |
| Hierarchy | workspace → channel → thread → message |
| Channel | lightweight parallel unit; owns a scratch directory in the workspace |
| Thread | one request lifecycle; binds coordinator session and turn serialization |
| Messages | new `messages` read model written transactionally beside the event journal |
| Coordinator sessions | one Pi session **per thread**, not per channel or per process |
| Git | demoted to an undo/redo snapshot log; no branches, merges, or user-history protection needed |
| Parallel isolation | filesystem-level (`channels/<id>/` scratch dirs), not worktrees |
| Named agents | worker-layer personas persisted as `.agents/personas/*.md` files |
| Transport | Bun HTTP JSON API + WebSocket deltas, sync cursors, pairing-token auth |
| TUI | deleted once clients exist; replaced by the server's sync layer |

## 2. Product context

The user does not work inside the workspace like a git repository. The
workspace is an agent environment:

- `.agents/` holds shared infrastructure: skills, memories, instructions,
  personas.
- Everything else is primarily a scratch environment where workers run
  scripts, write files, and do their jobs.
- The main reason a git repo exists at all is undo/redo over agent mutations.

This framing drives several decisions below that would be wrong for a
user-owned-repository product.

## 3. Entity model

```text
workspace  (the git repo + credential/checkpoint scope; rare to create)
└── channel    (lightweight, many, the parallelism axis)
    └── thread (one request lifecycle; session-bound)
        └── message (what clients render)
```

### 3.1 Workspace

Unchanged in role: one managed git repository, registered once, owning
credentials, checkpoints, and the runtime database under `~/.phi`.

### 3.2 Channel

A channel is a place, not an actor. It provides:

- A scratch directory `channels/<id>/` that dispatched workers use as `cwd`,
  giving filesystem-level isolation between concurrent lines of work.
- Subscription/notification scope and unread counts for clients.
- Channel-specific instructions via `channels/<id>/AGENTS.md`.

Channels are *not* conversation containers for session state. They may carry
a small purpose/topic line (DB row) rendered into prompts until richer notes
accumulate in AGENTS.md.

### 3.3 Thread

A thread is one user request lifecycle: brief, acknowledgements, questions,
spawned jobs, results, iteration. It is the unit that:

- Binds exactly one persistent Pi coordinator session (see §5).
- Serializes its own coordinator turns (turn lock keyed by thread id).
- Owns its jobs (`jobs.thread_id`) and messages (`messages.thread_id`).

Threads settle (single-exchange threads auto-settle so the sidebar does not
fill) and archive; their sessions archive with them.

### 3.4 Message

Messages are the presentation read model clients consume. The `events` table
remains the durable inbox/journal with dedupe keys, obligation policies,
visibility gating, and recovery semantics — none of that moves. Every journal
write that produces user-visible output also writes a `messages` row in the
same transaction.

The outbox effectively already became this after delivery was dropped;
`outbox` is superseded by `messages`.

## 4. Schema direction (migration 004)

```sql
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  purpose TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open | settled | archived
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  author TEXT NOT NULL CHECK (author IN ('user','coordinator','worker','system')),
  kind TEXT NOT NULL,                    -- ack|progress|result|question|job_update|...
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  seq INTEGER NOT NULL,                  -- monotonic per space; sync cursor
  created_at TEXT NOT NULL
);

ALTER TABLE jobs ADD COLUMN thread_id TEXT REFERENCES threads(id);
ALTER TABLE jobs ADD COLUMN channel_id TEXT REFERENCES channels(id);
```

Backfill: everything existing lands in a synthetic default channel
(`#general`). Threading history is mechanical because `outbox.event_id`
links results/questions to their originating `user_message`; one thread per
historical user message, downstream rows join by event id, jobs join via
`source_event_id`.

Existing domain verbs need only exposure and correlation, not redesign:
thread reply on a `needs_input` job routes through `enqueueFollowUp`;
cancel routes through `CancellationService.request`.

## 5. Coordinator sessions bind to threads

One Pi session per thread. Rationale:

- Context hygiene: session contains exactly this task's context; no
  accumulation of unrelated conversations; compaction fights relevance, not
  volume.
- Lifecycle alignment: threads settle and archive; sessions do too. Channels
  never end, so channel-bound sessions grow unboundedly by construction.
- Resumability: the harness session id is stored per thread and resumed after
  a process or server restart. If the harness cannot resume it, Phi replaces
  the session and seeds bounded context from the durable message log.
- Finer parallelism: turn locks key on thread id, so two threads in one
  channel turn concurrently.

Cross-task context becomes explicit rather than bled through session state:
each new thread's prompt is seeded with a small channel-context header
(purpose, recent thread titles/summaries). This is also the future seam for a
real memory service (still deferred).

Implementation: `AgentRuntime` keeps live processes in a map keyed by thread
id, while `thread_sessions` stores the durable `(harness, session id, agent,
config)` binding. Turns serialize through a per-thread promise chain. ACP
`session/resume` is preferred because Phi already owns the message read model;
`session/load` is used when resume is unavailable, and transcript recovery is
the final fallback.

## 6. Workspace layout

```text
workspace/
├── .agents/              # shared: skills, memories, instructions, personas
│   ├── agents.md
│   ├── skills/
│   ├── memories/
│   └── personas/
├── channels/
│   ├── backend/
│   │   └── AGENTS.md     # channel conventions, working knowledge
│   └── frontend/
└── shared/               # optional cross-channel artifact handoff
```

- Dispatches target `channels/<id>/` as `cwd`. Adapters already accept `cwd`
  as a launch parameter, so isolation requires zero adapter-contract changes.
- Instruction precedence per dispatch: workspace `.agents/` protocol →
  persona body (if any) → channel `AGENTS.md` → task prompt. Channel sections
  are injected into the brief at dispatch time; native discovery is not
  relied upon.
- `read_workspace` confinement tightens from whole-workspace to
  channel-scratch + read-only `.agents/` + `shared/`.
- Memories scope by location: general knowledge goes to
  `.agents/memories/`, channel-specific knowledge to that channel's
  `AGENTS.md`. The filesystem distinction is the scoping policy.

## 7. Git policy

Git is retained solely as a robust undo/redo log over agent mutations. Since
Phi owns the repo outright (no user works in it), branches, merges,
never-discard protections, baseline-commit ceremony, and shadow-ref schemes
are all unnecessary:

- Checkpoints form a linear snapshot stream over the workspace.
- Restore = `git reset --hard <sha>`, optionally path-limited to one
  channel subtree for per-channel undo.
- Two checkpoint streams with different cadences:
  - Scratch (`channels/**`, `shared/**`): frequent; purely for undo.
  - `.agents/`: deliberate and slow; accumulated value that a "restore
    workspace to 2pm" action must not silently wipe. Committed on its own
    trigger or excluded from scratch checkpoints.
- Recovery simplifies correspondingly: every dirty state is agent-made and
  disposable by design; no reconciliation against uncommitted user work.

Rejected alternatives, for the record:

- Per-thread/channel git worktrees and branch-per-thread integration flows:
  solve a merge problem that directory isolation removes; flip the spec's
  explicit non-goal against per-worker worktrees.
- Shadow ref namespaces (`refs/phi/...`): only meaningful when protecting a
  user-visible branch; moot here.
- Non-git snapshot stores: lose diff tooling and worker-harness assumptions
  for no gain given requirement 5 (workers are repo-native coding agents).
- Jujutsu: remains a watch item (operation log maps well onto checkpoints),
  still not a dependency.

## 8. Named agents (worker-layer personas)

Channels are places; named agents are actors. Phi adopts named agents at the
worker layer only: a persona is saved dispatch configuration plus
instructions, resolved by the host at dispatch time. One coordinator remains.

Persistence is filesystem, not SQLite, mirroring skills:

```text
.agents/personas/
├── architect.md
├── researcher.md
└── implementer.md
```

Format — markdown with frontmatter (mechanical defaults) and a body
(injected into the brief):

```markdown
---
adapter: codex
model: gpt-5-codex
effort: high
mode: mutating
description: Plans implementations and writes specs before any code
---

You are the architect. You never edit files directly...
```

All frontmatter except enough to pick an adapter is optional; unlisted
fields fall back to coordinator choice or host defaults so personas survive
catalog drift.

Resolution order at dispatch: explicit persona → explicit adapter/model
overrides → coordinator free choice. The host validates the resolved
combination against the live catalog (existing `resolveSelection` path); a
stale persona fails safely with a clear error.

Loading: scan `.agents/personas/*.md` at startup and on change; validate
frontmatter; unknown models surface as `doctor` warnings. `dispatch_job`
gains an optional `agent` parameter; the coordinator learns available
personas through `list_workers` output (or a small `list_personas` tool) so
routing can be semantic.

Attribution: job/message metadata records the persona name for display. It
is reference data derived from dispatch input, never a foreign key — a
deleted persona must not break history rendering.

Boundary: personas carry instructions and defaults only — never memory or
session state. Accumulated knowledge belongs in `.agents/memories/`
(shared) or channel AGENTS.md (scoped). An agent's identity is materialized
fresh into each thread's prompt from its file; nothing accretes toward a
second coordinator.

Deferred: coordinator-layer named agents (separate persistent coordinators,
separate memories/authorities). Only justified by genuinely different
authorities, which correlates more with multi-workspace than naming.

## 9. Server transport and clients

- New primary command: `phi serve` using `Bun.serve` (HTTP + WebSocket in
  one listener). `doctor` and `once` remain; direct mode stays the
  credential-free dev harness.
- HTTP JSON API for commands and keyset-paginated queries:
  `GET /channels/:id/threads?cursor=`, `GET /threads/:id/messages?before=`,
  `POST /threads/:id/messages`, `GET /workers`, `POST /jobs/:id/cancel`,
  persona/worker endpoints.
- WebSocket deltas fed by a change hook in `PhiStore` (post-commit emit) to
  a broadcast hub: `message.appended`, `thread.updated`,
  `job.status_changed`. Replaces the TUI controller's 100ms poll-and-diff.
- Resume/reconnect: client sends last-seen per-space `seq`; server replays
  missed rows. Mobile networks sleep; resume must be first-class.
- Streaming coordinator internals: traces stay a projection of Pi session
  events; stream frames over the socket and project durable history lazily
  from the session store rather than making traces authoritative state.

Security posture changes character from filesystem trust to network identity:

- Default bind `127.0.0.1`.
- LAN/remote access via pairing token (printed once / QR), per-device bearer
  tokens.
- TLS is delegated (reverse proxy or private networking such as
  Tailscale-style overlays) rather than built in; documented in the security
  boundary section.
- Cursor SDK browser login needs a remote-friendly flow now (server returns
  URL, client opens browser, polls status) since localhost callbacks fail
  from phones.

## 10. Implementation sequence

1. Extract an app-service interface (the operations the UI controller uses)
   from `PhiApp`; TUI consumes the interface. No behavior change.
2. `phi serve`: HTTP + WS + token auth over the existing store; TUI runs
   in-process against the same interface until deleted.
3. Migration 004: channels/threads/messages + `#general` backfill; swap
   polling for cursor queries and hub pushes.
4. Thread-scoped coordinator sessions and per-thread turn locks; channel
   scratch directories and per-channel AGENTS.md injection; tightened
   `read_workspace` confinement; simplified git checkpoint streams.
5. Delete `src/ui/` and OpenTUI dependencies; desktop client talks to the
   API like any other client.
6. Personas: loader, `dispatch_job` parameter, brief composition, doctor
   checks.
7. Later: multi-space registration (schema already allows multiple
   workspaces; `app.ts` hardcodes one today), file/image uploads written
   into the workspace and referenced from message metadata, mobile push
   notifications, fair cross-channel job scheduling if starvation appears.

Step ordering note: per-thread sessions and channel directories must land
with or before client work — without them channels are cosmetic, because all
coordinator responses still drain through one serial queue.

## 11. Invariants carried forward unchanged

Everything that makes Phi durable survives this evolution untouched:

- Event journal as the authoritative inbox (dedupe keys, obligation
  policies, visibility gating).
- Job state machine and terminal-state fencing.
- Stable identity keys (`dispatch_key`, message/follow-up/cancel keys).
- Persist-intent-before-effect and reconcile-don't-replay recovery rules.
- Adapter contract (launch/watch/followUp/cancel/reconcile) — `cwd`
  selection changes, the contract does not.
- Presentation never owns authority; clients reconnect from snapshots plus
  events.
