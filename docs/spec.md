# Phi Harness Specification

Status: Draft  
Scope: Single named agent, one shared workspace, delegated workers

Implementation plan: [implementation-plan.md](./implementation-plan.md)

## 1. Summary

Phi is a small knowledge-work harness built around one persistent coordinator. The coordinator receives user messages, communicates through a `SendMessage`-style outbox, and delegates substantive work to external worker harnesses such as Pi, Codex, Claude, or Cursor.

The system deliberately separates three kinds of state:

| Store            | Responsibility                                      |
| ---------------- | --------------------------------------------------- |
| Pi session JSONL | Coordinator conversation and model context          |
| Git repository   | Workspace files and their history                   |
| SQLite           | Asynchronous job, event, and message-delivery state |

The workspace is the only worker-visible filesystem surface. Runtime state and credentials live under the user's home directory and are not exposed to workers.

## 2. Goals

- Maintain one durable, user-facing coordinator.
- Keep the coordinator available while delegated workers run.
- Support multiple worker harnesses behind a small adapter interface.
- Give all workers a common workspace and common `.agents/` instructions.
- Preserve every meaningful workspace change in Git history.
- Recover pending jobs and undelivered messages after a process restart.
- Prevent duplicate completion handling and duplicate user messages.
- Keep the first implementation small enough to run as one local process with SQLite.

## 3. Non-goals

- Multiple named agents.
- A general distributed job system.
- Conflict-free attribution of concurrent writes to individual workers.
- Per-worker VMs or local worktrees.
- A separate artifact store. Outputs are ordinary workspace files.
- A database server.
- Full workflow automation or scheduled routines in the first version.
- A universal capability-routing system in the first version.
- A dedicated durable-memory service or coordinator memory-writing tools.

## 4. Filesystem layout

### 4.1 Workspace

```text
<workspace>/
├── .agents/
│   ├── agents.md
│   ├── system-prompt.md
│   ├── mcp.json
│   ├── skills/
│   └── memories/
├── .git/
└── ...user and worker files
```

The workspace is:

- The working directory passed to every worker.
- Shared by the coordinator and all workers.
- User-visible.
- Version-controlled.
- Free of Phi runtime state and credentials.

Phi bootstraps the workspace as a Git repository when necessary. A repository without `HEAD` receives a `Phi-Baseline: true` commit containing its current non-ignored files, including an allowed-empty commit for an empty workspace. If `HEAD` already exists, startup does not commit or otherwise alter existing changes.

Worker adapters must load the relevant `.agents/` instructions and translate or inject them for harnesses that do not discover the protocol natively.

### 4.2 Runtime directory

```text
~/.phi/
├── runtime.db
├── sessions/
│   ├── coordinator/
│   │   └── <session-id>.jsonl
│   └── workers/
│       └── <job-id>/
├── pi/
│   └── settings.json
├── credentials/                 # used only by isolated credential mode
├── logs/
└── tmp/
```

Permissions:

- `~/.phi/`: `0700`
- `runtime.db` and isolated credential files: `0600`

Credential mode defaults to `native`: Cursor, Claude, Codex, and Pi resolve authentication from their normal environment, user-home files, or operating-system credential stores. `isolated` mode instead relocates SDK configuration/authentication under `~/.phi/credentials` and requires a Phi key file or environment credential. Neither mode copies credentials into the managed workspace. Native SDK homes can also contain user-level harness configuration, so native reuse is not claimed to be a credential-only security boundary.

Workers must not receive the runtime directory as a working directory or input path. Phi-owned tools should reject paths that resolve inside it unless the operation is an internal host operation.

## 5. Components

### 5.1 Coordinator

The coordinator is a restricted Pi session responsible for:

- Understanding user requests.
- Sending acknowledgements and results.
- Deciding whether to answer inline or delegate.
- Preparing self-contained worker briefs.
- Launching, following up with, and cancelling workers.
- Interpreting worker completions.

The coordinator should have a deliberately small tool surface:

```text
send_message
list_workers
dispatch_job
follow_up_job
cancel_job
inspect_job
read_workspace
```

Ordinary assistant text is not delivered to the user. Only `send_message` creates an outbox message.

`read_workspace` is a Phi-owned, workspace-confined read tool. It lets the coordinator inspect files and job diffs when interpreting a result without giving it edit or shell access. Dedicated `search_memory` and `write_memory` tools are deferred; an optional `.agents/memories/` directory is workspace input, not an MVP memory service.

### 5.2 Worker adapters

Each external harness is normalized behind an adapter:

```ts
interface WorkerAdapter {
  readonly id: string;

  launch(input: {
    jobId: string;
    dispatchKey: string;
    prompt: string;
    cwd: string;
    mode: "read_only" | "mutating";
    model?: string;
    effort?: WorkerEffort;
  }): Promise<{
    externalRunId: string;
    continuationHandle?: string;
  }>;

  followUp(continuationHandle: string, message: string): Promise<void>;

  cancel(externalRunId: string): Promise<void>;

  watch(externalRunId: string): AsyncIterable<WorkerEvent>;

  reconcile?(input: {
    dispatchKey: string;
    externalRunId?: string;
    model?: string;
    effort?: WorkerEffort;
  }): Promise<
    | { state: "running"; externalRunId: string; continuationHandle?: string }
    | { state: "terminal"; event: WorkerEvent }
    | { state: "not_found" }
  >;
}
```

Every adapter exposes a model catalog with its default, selectable root models, supported effort values, discovery source, and whether the choice controls only the root or the entire run. `list_workers` combines that catalog with readiness and observable capabilities. The host rejects a model or effort not present in the adapter catalog; the coordinator never passes arbitrary sampled IDs through to an SDK.

`dispatchKey` is stable across process restarts. Adapters should pass it through to an external idempotency key, session name, or run metadata when the worker harness supports one. `reconcile` is used after a crash whose launch outcome is unknown; absence of this method means Phi must surface the uncertainty rather than launch a duplicate blindly.

### 5.3 Scheduler

The MVP allows all workers to execute concurrently, including multiple workers that may mutate the shared workspace, subject only to a configurable process-wide resource limit. There are no reader or writer leases and mutating work is not serialized. Workers may observe stale or changing files, overlapping writes may race, and the last write to a path wins. These are explicit MVP tradeoffs rather than isolation guarantees.

User messages have priority over worker completions and background events. In the MVP they are durably queued and selected first after the current serial coordinator turn settles; mid-turn steering is disabled.

### 5.4 Coordinator implementation

Use the released `@earendil-works/pi-coding-agent` SDK as a headless coordinator/session engine. Configure it with no built-in coding tools and only Phi-owned tools. Its prompt includes the registered adapter catalog, `list_workers` returns capability and readiness data, and `dispatch_job` rejects adapter IDs that are not registered. Use Pi's released session APIs for model context, compaction, and event streaming, but do not expose Pi's `InteractiveMode` as Phi's user interface.

Run the Phi host on Bun and use `bun:sqlite` for its control database. The initial compatibility baseline is Bun 1.3.12 with Pi 0.84.2; the checked-in runtime spike must pass whenever either version changes. This is an empirically validated combination, not a claim that every Node-targeted Pi or worker-harness path works under Bun.

Phi remains the authority for jobs, worker launch reconciliation, Git ownership, and user-message delivery. The conversation-first terminal UI is Phi-owned and implemented with pinned OpenTUI/Solid packages. Durable conversation rows come from SQLite events and outbox delivery. A toggleable, visually muted coordinator trace may project Pi's public tool execution events, non-redacted reasoning content, and final assistant text inline; it is diagnostic presentation, not user delivery or durable Phi state. Jobs and worker streams remain in optional operator views. The experimental durable harness and client/server TUI on Pi's `dev` branch remain design references, not runtime dependencies.

AI SDK is not an initial dependency. Pi still supplies model/tool-loop and session behavior while Phi owns terminal presentation. Reconsider the coordinator engine independently of the TUI if Pi's session/runtime opinions become a constraint or Phi later needs a web-first UI.

## 6. SQLite

### 6.1 Purpose

SQLite, accessed through `bun:sqlite`, is the durable coordination journal. It does not store workspace files, credentials, or the coordinator transcript.

It answers:

- Which jobs are pending or running?
- Which external run belongs to which dispatch?
- Can a worker be resumed?
- Has a completion event been processed?
- Has a user-facing message been delivered?
- Which global Git checkpoints were observed when a job launched and settled?

Recommended settings:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

All timestamps are UTC ISO 8601 strings. IDs are application-generated UUIDs or sortable UUID-compatible identifiers.

### 6.2 Schema

```sql
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    source_event_id TEXT NOT NULL REFERENCES events(id),
    adapter TEXT NOT NULL,
    dispatch_key TEXT NOT NULL UNIQUE,
    external_run_id TEXT,
    continuation_handle TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('read_only', 'mutating')),
    model TEXT,
    effort TEXT CHECK (
        effort IS NULL OR effort IN (
            'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
        )
    ),
    status TEXT NOT NULL CHECK (
        status IN (
            'queued',
            'launching',
            'running',
            'needs_input',
            'cancelling',
            'completing',
            'unknown',
            'completed',
            'failed',
            'cancelled'
        )
    ),
    prompt TEXT NOT NULL,
    observed_start_commit TEXT,
    observed_terminal_commit TEXT,
    error TEXT,
    cancel_key TEXT UNIQUE,
    cancel_requested_by_event_id TEXT REFERENCES events(id),
    cancel_requested_at TEXT,
    launch_attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX jobs_adapter_external_run
    ON jobs(adapter, external_run_id)
    WHERE external_run_id IS NOT NULL;

CREATE INDEX jobs_status_created
    ON jobs(status, created_at);

CREATE TABLE git_checkpoints (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    commit_sha TEXT NOT NULL UNIQUE,
    trigger_job_id TEXT REFERENCES jobs(id),
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE events (
    id TEXT PRIMARY KEY,
    job_id TEXT REFERENCES jobs(id),
    source TEXT NOT NULL CHECK (
        source IN ('user', 'worker', 'system')
    ),
    kind TEXT NOT NULL,
    dedupe_key TEXT,
    payload_json TEXT NOT NULL,
    obligation_policy TEXT NOT NULL CHECK (
        obligation_policy IN ('none', 'outbox')
    ),
    created_at TEXT NOT NULL,
    visible_at TEXT,
    processing_started_at TEXT,
    processed_at TEXT,
    error TEXT
);

CREATE UNIQUE INDEX events_dedupe
    ON events(dedupe_key)
    WHERE dedupe_key IS NOT NULL;

CREATE INDEX events_claimable
    ON events(source, created_at, id)
    WHERE visible_at IS NOT NULL AND processed_at IS NULL;

CREATE TABLE job_followups (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    source_event_id TEXT NOT NULL REFERENCES events(id),
    idempotency_key TEXT NOT NULL UNIQUE,
    external_run_id TEXT NOT NULL,
    continuation_handle TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'stale')
    ),
    created_at TEXT NOT NULL,
    sending_started_at TEXT,
    sent_at TEXT,
    error TEXT
);

CREATE INDEX job_followups_pending
    ON job_followups(created_at)
    WHERE status IN ('pending', 'failed');

CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    event_id TEXT REFERENCES events(id),
    kind TEXT NOT NULL CHECK (
        kind IN ('ack', 'progress', 'result', 'question')
    ),
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'delivering', 'delivered', 'failed')
    ),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    delivery_started_at TEXT,
    delivered_at TEXT,
    error TEXT
);

CREATE INDEX outbox_pending
    ON outbox(created_at)
    WHERE status IN ('pending', 'failed');
```

### 6.3 Event eligibility, deduplication, and obligations

`events` is both a journal and the coordinator's durable inbox. `wake()` never makes a row eligible; it only asks the loop to poll SQLite.

- User messages are inserted with `visible_at = created_at`, `obligation_policy = 'outbox'`, and no worker dedupe key.
- A worker terminal observation is inserted with `visible_at = NULL` in the transaction that moves the job to `completing`. After Phi creates or observes the next global workspace checkpoint, the transaction that marks the job terminal also sets the event's `visible_at`.
- A worker `needs_input` event becomes visible in the same transaction that changes the job to `needs_input`.
- Routine progress may be journaled already processed for `inspect_job`. Only progress deliberately routed through the coordinator is claimable, and it uses `obligation_policy = 'none'` so silence is a valid decision.
- Worker rows use a normalized dedupe key such as `worker:<adapter>:<external-run-id>:<native-event-id>`. When the harness has no native event ID, Phi hashes the stable normalized tuple `(adapter, externalRunId, kind, payload)`. `events_dedupe` makes replay convergence a schema invariant.

`EventRepository.claimNext()` runs in a short `BEGIN IMMEDIATE` transaction and selects only visible rows. Terminal worker events have a defensive job-state predicate even though their visibility is set atomically:

```sql
SELECT e.*
FROM events AS e
LEFT JOIN jobs AS j ON j.id = e.job_id
WHERE e.visible_at IS NOT NULL
  AND e.processed_at IS NULL
  AND e.processing_started_at IS NULL
  AND (
      e.kind NOT IN ('worker_completed', 'worker_failed', 'worker_cancelled')
      OR j.status IN ('completed', 'failed', 'cancelled')
  )
ORDER BY
  CASE e.source WHEN 'user' THEN 0 WHEN 'worker' THEN 1 ELSE 2 END,
  e.created_at,
  e.id
LIMIT 1;
```

User messages therefore have explicit priority rather than relying on wake order. Stale `processing_started_at` claims are cleared during recovery.

The transaction that marks an event processed checks its policy:

- `outbox`: at least one outbox row must reference this event.
- `none`: a settled coordinator turn may mark the event processed without creating a job or message.

Every user message, worker completion, and worker question uses `outbox`. Dispatching a job does not by itself satisfy the user-response obligation; asynchronous dispatch also requires an acknowledgement.

### 6.4 Worker concurrency and checkpoint serialization

Job claims do not inspect other active jobs. `mode` is advisory metadata for prompting, observability, and policy; it is not a lease. The scheduler may launch any queued job while resource capacity remains.

Only the short host-side Git checkpoint operation is serialized because Git index and commit updates are global workspace operations. This does not pause or fence workers. A checkpoint may therefore contain writes from several workers or the user, and a job's observed start and terminal commits are correlation points rather than ownership boundaries.

## 7. Job lifecycle

```text
queued
  ├── cancelled
  └── launching
        ├── running
        │     ├── needs_input ── running
        │     ├── cancelling
        │     └── completing
        ├── cancelling
        └── unknown

needs_input ── cancelling|completing
cancelling ── cancelled|completed|failed|unknown
completing ── completed|failed|cancelled
unknown ── running|completed|failed|cancelled
```

Rules:

- `queued` jobs have not been launched.
- `launching` means launch intent was committed but the adapter result has not yet been recorded.
- `running` jobs have an active adapter run.
- `needs_input` jobs retain their continuation handle.
- `cancelling` means the durable cancellation intent was recorded before calling the adapter.
- `completing` means a terminal worker event is durable while Phi creates or observes a global workspace checkpoint and finalizes the terminal job row.
- `unknown` means Phi cannot yet prove whether an external launch or effect occurred. It requires reconciliation or explicit operator action and is never blindly replayed.
- Terminal states are `completed`, `failed`, and `cancelled`.
- Every worker completion is first written to `events` as invisible, then made visible atomically with the terminal job state after checkpoint observation.
- Processing the same completion event twice must not produce a second result message or commit.

## 8. Dispatch and completion flow

### 8.1 Dispatch

1. Persist the user event.
2. Run the coordinator.
3. Coordinator calls `send_message` with an acknowledgement when work will continue asynchronously.
4. Coordinator calls `dispatch_job` with a self-contained prompt and mode.
5. Host creates a `queued` job with a stable `dispatch_key`. Repeating the same coordinator tool invocation returns the existing job.
6. Scheduler atomically claims the job by changing it to `launching` and incrementing `launch_attempts`.
7. Host records the current global Git `HEAD` in `observed_start_commit` for correlation only.
8. Adapter launches the worker in the workspace using `dispatch_key` as its idempotency or correlation key.
9. Host records `external_run_id`, optional `continuation_handle`, and `status = 'running'`.
10. Coordinator turn ends while the worker continues.

### 8.2 Completion

1. Adapter receives the native worker completion.
2. Host atomically writes one deduplicated worker event with `visible_at = NULL` and changes the job to `completing`.
3. The checkpoint service serially inspects the shared workspace and creates a global checkpoint if tracked or untracked content changed. The checkpoint is triggered by the completion but is not attributed to that job.
4. Host atomically records the observed terminal revision, marks the job terminal, and sets the completion event's `visible_at`.
5. Host wakes the coordinator. Even if another wake polls earlier, `claimNext()` cannot select the invisible completion row or a terminal event whose job is nonterminal.
6. Coordinator uses `inspect_job` and, when needed, `read_workspace` to interpret the worker result and workspace changes.
7. Coordinator calls `send_message` with the result.
8. Outbox delivery marks the message delivered.
9. Event is marked processed.

If Phi crashes after `git commit` but before step 4, recovery locates the checkpoint by its Phi checkpoint trailer and finalizes the existing revision. It must not create a second commit.

The database transaction ensures that this `obligation_policy = 'outbox'` event cannot be marked processed unless its resulting outbox record exists.

### 8.3 Worker questions and follow-up

1. The adapter emits a stable `needs_input` event containing the question and continuation handle.
2. One transaction deduplicates the event, changes `running → needs_input`, and makes the event visible with `obligation_policy = 'outbox'`.
3. The coordinator sends the user a `question` outbox message. The message metadata includes `job_id` and the source worker event ID.
4. The user's reply is accepted as a normal user event with optional `reply_to_outbox_id` metadata. The coordinator may also resolve the only pending question from session context, but the explicit link is authoritative when present.
5. `follow_up_job` derives `followup:<user-event-id>:<job-id>`, verifies that the same launch is still in `needs_input`, and inserts one `job_followups(status = 'pending')` row. It does not call the adapter inside that transaction.
6. The follow-up dispatcher claims the row, revalidates the job and continuation handle, then calls `adapter.followUp` outside SQLite. Definite acceptance changes the follow-up to `sent` and `needs_input → running`; an ambiguous outcome changes the follow-up and nonterminal job to `unknown` for reconciliation.

Terminal completion always wins a race with follow-up. If the job is already terminal when `follow_up_job` or its dispatcher validates it, the follow-up becomes `stale`, no adapter call is made, and the coordinator reports the terminal result. If completion arrives after an adapter call has begun, the terminal job state is never regressed; any late follow-up acknowledgement or worker output is stored as a late observation.

### 8.4 Cancellation

- `cancel_job` derives `cancel:<source-event-id>:<job-id>` and records cancellation intent before any external call.
- A queued job is cancelled atomically and is never launched.
- A launching, running, or `needs_input` job changes to `cancelling`; the adapter call occurs outside the transaction. An authoritative terminal response or worker terminal event completes cancellation. An ambiguous cancellation outcome changes the job to `unknown`.
- A `completing` or terminal job is not sent a cancellation call; the tool returns its current state and the coordinator reports that completion already won.
- Repeated cancellation is idempotent. A completion that races cancellation wins according to the first committed terminal state, and late callbacks cannot regress it.

## 9. Git policy

Git is the initial version-control implementation because worker harnesses commonly understand Git repositories.

Rules:

- Workers are instructed not to commit, reset, clean, rebase, or rewrite history, but Phi does not treat prompt instructions as an enforceable sandbox.
- Phi records the global revision observed at launch and settlement as correlation metadata only.
- All workers may run concurrently. Stale reads, overlapping writes, and last-write-wins results are accepted MVP behavior.
- Existing workspace changes must never be silently discarded, and a dirty workspace does not block launch.
- Phi periodically and at terminal settlement creates global checkpoints containing the workspace state visible at that instant. A checkpoint may mix changes from multiple workers and the user.
- Failed or cancelled workers' partial changes remain recoverable in later global checkpoints.

Commit message format:

```text
phi checkpoint: <short summary>

Phi-Checkpoint: <checkpoint-id>
Trigger-Job: <job-id-or-none>
```

Jujutsu is deferred. It may later provide more granular operation history, but the MVP makes no per-job attribution claim for a shared working copy.

## 10. Worker instructions

Every worker dispatch must include these invariants, either directly or through `.agents/agents.md`:

- Work only inside the provided workspace.
- Read and follow the workspace `.agents/` instructions.
- Never read or modify `~/.phi`.
- Do not commit, reset, clean, rebase, or discard existing changes.
- Treat existing files and changes as user-owned.
- Report changed files and the outcome succinctly.
- Do not communicate directly with the user.
- Do not assume authority beyond the delegated task.

## 11. Message delivery

`send_message` inserts an outbox row; it does not directly write to the UI or transport.

The delivery loop:

1. Claims a `pending` or retryable `failed` row.
2. Sets `status = 'delivering'`.
3. Sends using `idempotency_key` where the transport supports it.
4. Marks the row `delivered` with `delivered_at`.
5. On failure, records the error and makes the row retryable.

Acknowledgement and result are separate obligations. Delivering an acknowledgement does not mark the originating work complete.

For known event types, the host derives the outbox key instead of trusting model-generated wording:

```text
user message primary response:  message:event:<event-id>:primary
worker completion result:        message:job:<job-id>:result
worker question:                 message:event:<event-id>:question
worker progress:                 message:event:<event-id>:progress
```

The user-message `primary` slot may contain either an inline `result` or an asynchronous `ack`; the first committed row wins on replay. A later worker completion has its own job-derived result slot. The tool may accept a semantic key for model ergonomics, but the host rejects an incompatible kind and canonicalizes the database idempotency key for these event types. Free-form semantic keys remain only for genuinely repeatable operations such as dispatching multiple jobs from one user event.

## 12. Recovery

On startup, Phi:

1. Opens SQLite and runs migrations.
2. Registers or validates the workspace path.
3. Reconciles `launching` jobs by `dispatch_key`. If the adapter cannot prove whether launch occurred, changes them to `unknown`; it does not launch them again automatically.
4. Reconnects to `running` adapter jobs when supported.
5. Finalizes `completing` jobs by finding an existing checkpoint-tagged commit or safely creating the missing global checkpoint from the retained working copy.
6. Reconciles `cancelling` jobs and `sending` or `unknown` follow-ups without blindly repeating external effects.
7. Marks provably unrecoverable runs failed and creates or reveals their deduplicated completion event in the terminal transaction.
8. Clears stale processing claims and requeues only visible, unprocessed events.
9. Retries pending or failed outbox messages.
10. Resumes queued launches up to the configured resource limit without consulting reader or writer leases.
11. Compares recorded checkpoint revisions with current workspace state and reports inconsistencies rather than rewriting history.

### 12.1 Durability invariants

Phi adopts these invariants from Pi's durable-harness work without copying its full state machine:

1. Persist intent before starting an external effect. A user event, job acceptance, or outbox obligation is durable before work begins.
2. Give each effect a stable identity. Repeated coordinator tool calls and restart recovery converge on the same `dispatch_key`, job, event, or outbox row.
3. Treat live events as observations, not proof of completion. Only committed SQLite state authorizes recovery decisions.
4. Make a completion event claimable only in the same transaction that records the terminal job state. Processing and user delivery can then be retried without rerunning the worker.
5. Never infer completion from partial output. A disconnected stream or partially changed workspace has an unknown outcome until reconciled.
6. Never replay an effect with unknown safety. Reconcile it, synthesize an explicit interrupted result, or ask for operator action.
7. Fence late writes. Events and callbacks must verify that the job and launch attempt they belong to are still current.
8. Keep presentation separate from authority. The TUI may reconnect from a snapshot plus new events, but it does not own job or delivery state.

Durable partial assistant frames and tool-progress checkpoints are deferred. They improve reconnect presentation, but are not needed for the first Phi coordinator because job state and user-message obligations are independently durable.

## 13. Security boundaries

- Credentials are resolved from each harness's normal user-home or operating-system login store by default, or from `~/.phi/credentials` in explicit isolated mode.
- Credentials are never committed to the workspace.
- `.agents/mcp.json` contains connection configuration, not plaintext secrets.
- Worker output and external content are treated as untrusted data.
- Delegating work never grants more authority than the originating user request.
- External side effects should eventually be divided into read, draft, and commit operations; explicit approval policy is deferred from the initial filesystem-only MVP.

## 14. Initial implementation sequence

1. Create the runtime directory and SQLite migrations.
2. Register one workspace.
3. Start one persistent Pi coordinator session.
4. Implement `send_message` and outbox delivery.
5. Implement one worker adapter.
6. Implement synchronous dispatch first.
7. Add durable asynchronous jobs and completion events.
8. Add durable worker questions, follow-ups, and cancellation.
9. Add global Git checkpoint capture and recovery.
10. Add a second adapter only after recovery and delivery are reliable.

## 15. Open questions

- Which worker adapter should be implemented first?
- What user transport receives outbox messages in the first version?
- Should failed worker changes always receive a WIP commit?
- How should the coordinator select or roll over Pi session episodes?
- Which `.agents/` files are injected into each worker harness, and in what order?
