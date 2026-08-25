import type { SQLQueryBindings } from "bun:sqlite";
import type {
  EventRecord,
  FollowUpRecord,
  JobMode,
  JobRecord,
  JobStatus,
  MessageKind,
  MessageRecord,
  WorkerEffort,
} from "../domain.ts";
import { terminalJobStatuses } from "../domain.ts";
import { newId, now } from "../ids.ts";
import type { PhiDatabase } from "./database.ts";

type Row = Record<string, unknown>;

const s = (value: unknown): string => String(value);
const nullable = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const parse = (value: unknown): Record<string, unknown> =>
  JSON.parse(String(value)) as Record<string, unknown>;
const missing = (what: string, id: string): Error =>
  new Error(`${what} not found: ${id}`);

function eventFrom(row: Row): EventRecord {
  return {
    id: s(row.id),
    jobId: nullable(row.job_id),
    source: s(row.source) as EventRecord["source"],
    kind: s(row.kind),
    dedupeKey: nullable(row.dedupe_key),
    payload: parse(row.payload_json),
    obligationPolicy: s(
      row.obligation_policy,
    ) as EventRecord["obligationPolicy"],
    createdAt: s(row.created_at),
    visibleAt: nullable(row.visible_at),
    processingStartedAt: nullable(row.processing_started_at),
    processedAt: nullable(row.processed_at),
    error: nullable(row.error),
  };
}

function jobFrom(row: Row): JobRecord {
  return {
    id: s(row.id),
    adapter: s(row.adapter),
    dispatchKey: s(row.dispatch_key),
    externalRunId: nullable(row.external_run_id),
    continuationHandle: nullable(row.continuation_handle),
    mode: s(row.mode) as JobMode,
    model: nullable(row.model),
    effort: nullable(row.effort) as WorkerEffort | null,
    status: s(row.status) as JobStatus,
    prompt: s(row.prompt),
    observedTerminalCommit: nullable(row.observed_terminal_commit),
    error: nullable(row.error),
    cancelKey: nullable(row.cancel_key),
    createdAt: s(row.created_at),
    startedAt: nullable(row.started_at),
    finishedAt: nullable(row.finished_at),
    updatedAt: s(row.updated_at),
  };
}

function messageFrom(row: Row): MessageRecord {
  return {
    id: s(row.id),
    eventId: nullable(row.event_id),
    kind: s(row.kind) as MessageKind,
    content: s(row.content),
    metadata: parse(row.metadata_json),
    idempotencyKey: s(row.idempotency_key),
    createdAt: s(row.created_at),
  };
}

function followUpFrom(row: Row): FollowUpRecord {
  return {
    id: s(row.id),
    jobId: s(row.job_id),
    idempotencyKey: s(row.idempotency_key),
    externalRunId: s(row.external_run_id),
    continuationHandle: s(row.continuation_handle),
    content: s(row.content),
    status: s(row.status) as FollowUpRecord["status"],
    createdAt: s(row.created_at),
    sendingStartedAt: nullable(row.sending_started_at),
    sentAt: nullable(row.sent_at),
    error: nullable(row.error),
  };
}

export class PhiStore {
  constructor(private readonly database: PhiDatabase) {}

  get raw() {
    return this.database.raw;
  }

  acceptUserMessage(
    content: string,
    metadata: Record<string, unknown> = {},
  ): EventRecord {
    const id = newId();
    const timestamp = now();
    return eventFrom(
      this.raw
        .query(
          `INSERT INTO events(id,source,kind,payload_json,obligation_policy,created_at,visible_at) VALUES(?,'user','user_message',?,'outbox',?,?) RETURNING *`,
        )
        .get(
          id,
          JSON.stringify({ content, ...metadata }),
          timestamp,
          timestamp,
        ) as Row,
    );
  }

  getEvent(id: string): EventRecord {
    const row = this.raw
      .query("SELECT * FROM events WHERE id = ?")
      .get(id) as Row | null;
    if (!row) throw missing("event", id);
    return eventFrom(row);
  }

  listEvents(): EventRecord[] {
    return (
      this.raw
        .query("SELECT * FROM events ORDER BY created_at,id")
        .all() as Row[]
    ).map(eventFrom);
  }

  listJobEvents(jobId: string): EventRecord[] {
    return (
      this.raw
        .query("SELECT * FROM events WHERE job_id=? ORDER BY created_at,id")
        .all(jobId) as Row[]
    ).map(eventFrom);
  }

  claimNextEvent(): EventRecord | null {
    return this.database.immediate(() => {
      const row = this.raw
        .query(
          `SELECT e.* FROM events e LEFT JOIN jobs j ON j.id=e.job_id
        WHERE e.visible_at IS NOT NULL AND e.processed_at IS NULL AND e.processing_started_at IS NULL
        AND (e.kind NOT IN ('worker_completed','worker_failed','worker_cancelled') OR j.status IN ('completed','failed','cancelled'))
        ORDER BY CASE e.source WHEN 'user' THEN 0 WHEN 'worker' THEN 1 ELSE 2 END,e.created_at,e.id LIMIT 1`,
        )
        .get() as Row | null;
      if (!row) return null;
      const timestamp = now();
      const result = this.raw
        .query(
          "UPDATE events SET processing_started_at=?,error=NULL WHERE id=? AND processing_started_at IS NULL AND processed_at IS NULL",
        )
        .run(timestamp, s(row.id));
      return result.changes === 1 ? this.getEvent(s(row.id)) : null;
    });
  }

  releaseEvent(id: string, error: string): void {
    this.raw
      .query(
        "UPDATE events SET processing_started_at=NULL,error=? WHERE id=? AND processed_at IS NULL",
      )
      .run(error, id);
  }

  markEventProcessed(id: string): void {
    this.database.immediate(() => {
      const event = this.getEvent(id);
      if (event.processedAt) return;
      if (event.obligationPolicy === "outbox") {
        const row = this.raw
          .query("SELECT count(*) AS count FROM messages WHERE event_id=?")
          .get(id) as { count: number };
        if (row.count < 1)
          throw new Error(`event ${id} requires an outbox message`);
      }
      this.raw
        .query(
          "UPDATE events SET processed_at=?,processing_started_at=NULL,error=NULL WHERE id=?",
        )
        .run(now(), id);
    });
  }

  acceptJob(input: {
    adapter: string;
    key: string;
    prompt: string;
    mode: JobMode;
    model?: string;
    effort?: WorkerEffort;
  }): { job: JobRecord; created: boolean } {
    return this.database.immediate(() => {
      const existing = this.raw
        .query("SELECT * FROM jobs WHERE dispatch_key=?")
        .get(input.key) as Row | null;
      if (existing) return { job: jobFrom(existing), created: false };
      const id = newId();
      const timestamp = now();
      const row = this.raw
        .query(
          `INSERT INTO jobs(id,adapter,dispatch_key,mode,model,effort,status,prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?) RETURNING *`,
        )
        .get(
          id,
          input.adapter,
          input.key,
          input.mode,
          input.model ?? null,
          input.effort ?? null,
          input.prompt,
          timestamp,
          timestamp,
        ) as Row;
      return { job: jobFrom(row), created: true };
    });
  }

  getJob(id: string): JobRecord {
    const row = this.raw
      .query("SELECT * FROM jobs WHERE id=?")
      .get(id) as Row | null;
    if (!row) throw missing("job", id);
    return jobFrom(row);
  }

  listJobs(statuses?: JobStatus[]): JobRecord[] {
    if (!statuses?.length)
      return (
        this.raw
          .query("SELECT * FROM jobs ORDER BY created_at,id")
          .all() as Row[]
      ).map(jobFrom);
    const marks = statuses.map(() => "?").join(",");
    return (
      this.raw
        .query(
          `SELECT * FROM jobs WHERE status IN (${marks}) ORDER BY created_at,id`,
        )
        .all(...(statuses as SQLQueryBindings[])) as Row[]
    ).map(jobFrom);
  }

  claimNextJob(): JobRecord | null {
    return this.database.immediate(() => {
      const row = this.raw
        .query(
          "SELECT id FROM jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1",
        )
        .get() as { id: string } | null;
      if (!row) return null;
      const timestamp = now();
      const result = this.raw
        .query(
          `UPDATE jobs SET status='launching',started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status='queued'`,
        )
        .run(timestamp, timestamp, row.id);
      return result.changes === 1 ? this.getJob(row.id) : null;
    });
  }

  recordRunning(
    id: string,
    externalRunId: string,
    continuationHandle?: string,
  ): JobRecord {
    const result = this.raw
      .query(
        `UPDATE jobs SET status='running',external_run_id=?,continuation_handle=?,updated_at=? WHERE id=? AND status='launching'`,
      )
      .run(externalRunId, continuationHandle ?? null, now(), id);
    if (result.changes !== 1) throw new Error(`job ${id} is not launching`);
    return this.getJob(id);
  }

  markUnknown(id: string, error: string): JobRecord {
    const job = this.getJob(id);
    if (terminalJobStatuses.has(job.status)) return job;
    this.raw
      .query("UPDATE jobs SET status='unknown',error=?,updated_at=? WHERE id=?")
      .run(error, now(), id);
    return this.getJob(id);
  }

  recordProgress(input: {
    jobId: string;
    kind: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
    visible?: boolean;
  }): EventRecord {
    const existing = this.raw
      .query("SELECT * FROM events WHERE dedupe_key=?")
      .get(input.dedupeKey) as Row | null;
    if (existing) return eventFrom(existing);
    const id = newId();
    const timestamp = now();
    return eventFrom(
      this.raw
        .query(
          `INSERT INTO events(id,job_id,source,kind,dedupe_key,payload_json,obligation_policy,created_at,visible_at,processed_at) VALUES(?,?,'worker',?,?,?,'none',?,?,?) RETURNING *`,
        )
        .get(
          id,
          input.jobId,
          input.kind,
          input.dedupeKey,
          JSON.stringify(input.payload),
          timestamp,
          input.visible ? timestamp : null,
          input.visible ? null : timestamp,
        ) as Row,
    );
  }

  recordNeedsInput(input: {
    jobId: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
    continuationHandle: string;
  }): EventRecord {
    return this.database.immediate(() => {
      const existing = this.raw
        .query("SELECT * FROM events WHERE dedupe_key=?")
        .get(input.dedupeKey) as Row | null;
      if (existing) return eventFrom(existing);
      const job = this.getJob(input.jobId);
      if (terminalJobStatuses.has(job.status))
        throw new Error(`job ${job.id} is terminal`);
      const id = newId();
      const timestamp = now();
      const event = eventFrom(
        this.raw
          .query(
            `INSERT INTO events(id,job_id,source,kind,dedupe_key,payload_json,obligation_policy,created_at,visible_at) VALUES(?,?,'worker','worker_needs_input',?,?,'outbox',?,?) RETURNING *`,
          )
          .get(
            id,
            job.id,
            input.dedupeKey,
            JSON.stringify(input.payload),
            timestamp,
            timestamp,
          ) as Row,
      );
      this.raw
        .query(
          "UPDATE jobs SET status='needs_input',continuation_handle=?,updated_at=? WHERE id=? AND status='running'",
        )
        .run(input.continuationHandle, timestamp, job.id);
      return event;
    });
  }

  beginCompletion(input: {
    jobId: string;
    kind: "worker_completed" | "worker_failed" | "worker_cancelled";
    dedupeKey: string;
    payload: Record<string, unknown>;
  }): { event: EventRecord; created: boolean } {
    return this.database.immediate(() => {
      const existing = this.raw
        .query("SELECT * FROM events WHERE dedupe_key=?")
        .get(input.dedupeKey) as Row | null;
      if (existing) return { event: eventFrom(existing), created: false };
      const job = this.getJob(input.jobId);
      const id = newId();
      const timestamp = now();
      const row = this.raw
        .query(
          `INSERT INTO events(id,job_id,source,kind,dedupe_key,payload_json,obligation_policy,created_at) VALUES(?,?,'worker',?,?,?,'outbox',?) RETURNING *`,
        )
        .get(
          id,
          job.id,
          input.kind,
          input.dedupeKey,
          JSON.stringify(input.payload),
          timestamp,
        ) as Row;
      if (!terminalJobStatuses.has(job.status)) {
        this.raw
          .query("UPDATE jobs SET status='completing',updated_at=? WHERE id=?")
          .run(timestamp, job.id);
      }
      return { event: eventFrom(row), created: true };
    });
  }

  finalizeCompletion(input: {
    jobId: string;
    eventId: string;
    status: "completed" | "failed" | "cancelled";
    observedTerminalCommit: string | null;
    error?: string;
  }): JobRecord {
    return this.database.immediate(() => {
      const job = this.getJob(input.jobId);
      if (terminalJobStatuses.has(job.status)) return job;
      if (job.status !== "completing")
        throw new Error(`job ${job.id} is ${job.status}, not completing`);
      const timestamp = now();
      this.raw
        .query(
          "UPDATE jobs SET status=?,observed_terminal_commit=?,error=?,finished_at=?,updated_at=? WHERE id=?",
        )
        .run(
          input.status,
          input.observedTerminalCommit,
          input.error ?? null,
          timestamp,
          timestamp,
          job.id,
        );
      this.raw
        .query(
          "UPDATE events SET visible_at=? WHERE id=? AND job_id=? AND visible_at IS NULL",
        )
        .run(timestamp, input.eventId, job.id);
      return this.getJob(job.id);
    });
  }

  putMessage(input: {
    eventId: string;
    kind: MessageKind;
    content: string;
    metadata?: Record<string, unknown>;
    idempotencyKey: string;
  }): { message: MessageRecord; created: boolean } {
    return this.database.immediate(() => {
      const existing = this.raw
        .query("SELECT * FROM messages WHERE idempotency_key=?")
        .get(input.idempotencyKey) as Row | null;
      if (existing) return { message: messageFrom(existing), created: false };
      this.getEvent(input.eventId);
      const row = this.raw
        .query(
          `INSERT INTO messages(id,event_id,kind,content,metadata_json,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?) RETURNING *`,
        )
        .get(
          newId(),
          input.eventId,
          input.kind,
          input.content,
          JSON.stringify(input.metadata ?? {}),
          input.idempotencyKey,
          now(),
        ) as Row;
      return { message: messageFrom(row), created: true };
    });
  }

  listMessages(): MessageRecord[] {
    return (
      this.raw
        .query("SELECT * FROM messages ORDER BY created_at,id")
        .all() as Row[]
    ).map(messageFrom);
  }

  enqueueFollowUp(input: { jobId: string; key: string; content: string }): {
    followUp: FollowUpRecord;
    created: boolean;
  } {
    return this.database.immediate(() => {
      const existing = this.raw
        .query("SELECT * FROM job_followups WHERE idempotency_key=?")
        .get(input.key) as Row | null;
      if (existing) return { followUp: followUpFrom(existing), created: false };
      const job = this.getJob(input.jobId);
      if (
        job.status !== "needs_input" ||
        !job.externalRunId ||
        !job.continuationHandle
      )
        throw new Error(`job ${job.id} cannot accept follow-up`);
      const row = this.raw
        .query(
          `INSERT INTO job_followups(id,job_id,idempotency_key,external_run_id,continuation_handle,content,status,created_at) VALUES(?,?,?,?,?,?,'pending',?) RETURNING *`,
        )
        .get(
          newId(),
          job.id,
          input.key,
          job.externalRunId,
          job.continuationHandle,
          input.content,
          now(),
        ) as Row;
      return { followUp: followUpFrom(row), created: true };
    });
  }

  getFollowUp(id: string): FollowUpRecord {
    const row = this.raw
      .query("SELECT * FROM job_followups WHERE id=?")
      .get(id) as Row | null;
    if (!row) throw missing("follow-up", id);
    return followUpFrom(row);
  }

  claimFollowUp(): FollowUpRecord | null {
    return this.database.immediate(() => {
      const row = this.raw
        .query(
          `SELECT f.id FROM job_followups f JOIN jobs j ON j.id=f.job_id WHERE f.status IN ('pending','failed') AND j.status='needs_input' ORDER BY f.created_at,f.id LIMIT 1`,
        )
        .get() as { id: string } | null;
      if (!row) return null;
      const result = this.raw
        .query(
          "UPDATE job_followups SET status='sending',sending_started_at=?,error=NULL WHERE id=? AND status IN ('pending','failed')",
        )
        .run(now(), row.id);
      return result.changes === 1 ? this.getFollowUp(row.id) : null;
    });
  }

  settleFollowUp(
    id: string,
    outcome: "sent" | "failed" | "unknown" | "stale",
    error?: string,
  ): void {
    this.database.immediate(() => {
      const followUp = this.getFollowUp(id);
      const job = this.getJob(followUp.jobId);
      const timestamp = now();
      const finalOutcome = terminalJobStatuses.has(job.status)
        ? "stale"
        : outcome;
      this.raw
        .query("UPDATE job_followups SET status=?,sent_at=?,error=? WHERE id=?")
        .run(
          finalOutcome,
          finalOutcome === "sent" ? timestamp : null,
          error ?? null,
          id,
        );
      if (finalOutcome === "sent" && job.status === "needs_input")
        this.raw
          .query("UPDATE jobs SET status='running',updated_at=? WHERE id=?")
          .run(timestamp, job.id);
      if (finalOutcome === "unknown" && !terminalJobStatuses.has(job.status))
        this.raw
          .query(
            "UPDATE jobs SET status='unknown',error=?,updated_at=? WHERE id=?",
          )
          .run(error ?? "follow-up outcome unknown", timestamp, job.id);
    });
  }

  requestCancellation(input: { jobId: string; key: string }): JobRecord {
    return this.database.immediate(() => {
      const job = this.getJob(input.jobId);
      if (
        job.cancelKey === input.key ||
        terminalJobStatuses.has(job.status) ||
        job.status === "completing"
      )
        return job;
      const timestamp = now();
      if (job.status === "queued") {
        this.raw
          .query(
            "UPDATE jobs SET status='cancelled',cancel_key=?,updated_at=?,finished_at=? WHERE id=?",
          )
          .run(input.key, timestamp, timestamp, job.id);
      } else {
        this.raw
          .query(
            "UPDATE jobs SET status='cancelling',cancel_key=?,updated_at=? WHERE id=?",
          )
          .run(input.key, timestamp, job.id);
      }
      return this.getJob(job.id);
    });
  }

  recordCheckpoint(input: {
    id: string;
    commitSha: string;
    status: string;
  }): void {
    this.raw
      .query(
        "INSERT OR IGNORE INTO git_checkpoints(id,commit_sha,status,created_at) VALUES(?,?,?,?)",
      )
      .run(input.id, input.commitSha, input.status, now());
  }

  pendingTerminalEvent(jobId: string): EventRecord | null {
    const row = this.raw
      .query(
        "SELECT * FROM events WHERE job_id=? AND visible_at IS NULL AND kind IN ('worker_completed','worker_failed','worker_cancelled') ORDER BY created_at,id LIMIT 1",
      )
      .get(jobId) as Row | null;
    return row ? eventFrom(row) : null;
  }

  recoverClaims(): void {
    this.database.immediate(() => {
      this.raw.exec(
        "UPDATE events SET processing_started_at=NULL WHERE processed_at IS NULL",
      );
      this.raw.exec(
        "UPDATE job_followups SET status='unknown',error=COALESCE(error,'process stopped during follow-up delivery') WHERE status='sending'",
      );
    });
  }
}
