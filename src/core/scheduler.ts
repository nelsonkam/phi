import { Cron } from "croner";
import type { PhiStore } from "@/core/store/store";

const MAX_TIMER_MS = 2_147_000_000;
const DEFAULT_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;

export type TaskSchedule =
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expression: string; timezone?: string };

export interface ScheduledTaskDefinition {
  id: string;
  handler: string;
  schedule: TaskSchedule;
  payload?: Record<string, unknown>;
  catchUp?: "run_once" | "skip";
  enabled?: boolean;
  initialRun?: "now" | "next_occurrence";
}

export interface ScheduledTask extends ScheduledTaskDefinition {
  payload: Record<string, unknown>;
  catchUp: "run_once" | "skip";
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ScheduledTaskHandler = (
  payload: Record<string, unknown>,
  task: ScheduledTask,
) => Promise<void> | void;

interface ScheduledTaskRow {
  id: string;
  handler: string;
  schedule_kind: string;
  schedule_value: string;
  timezone: string | null;
  payload_json: string;
  catch_up: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

export class SchedulerService {
  private readonly handlers = new Map<string, ScheduledTaskHandler>();
  private readonly running = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private closed = false;

  constructor(
    private readonly store: PhiStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  registerHandler(name: string, handler: ScheduledTaskHandler): void {
    if (!name.trim()) throw new Error("scheduled task handler name is required");
    if (this.handlers.has(name)) {
      throw new Error(`scheduled task handler ${JSON.stringify(name)} is already registered`);
    }
    this.handlers.set(name, handler);
  }

  upsertTask(definition: ScheduledTaskDefinition): ScheduledTask {
    validateDefinition(definition);
    const existing = this.getTask(definition.id);
    const now = this.now();
    const enabled = definition.enabled ?? true;
    const scheduleChanged =
      !existing || !sameSchedule(existing.schedule, definition.schedule);
    const nextRunAt =
      enabled && !existing && definition.initialRun === "now"
        ? now.toISOString()
        : enabled && existing?.enabled && !scheduleChanged
        ? existing.nextRunAt
        : enabled
          ? nextOccurrence(definition.schedule, now)?.toISOString() ?? null
          : null;
    const createdAt = existing?.createdAt ?? now.toISOString();
    const updatedAt = now.toISOString();
    const scheduleValue =
      definition.schedule.kind === "interval"
        ? String(definition.schedule.everyMs)
        : definition.schedule.expression;
    const timezone =
      definition.schedule.kind === "cron"
        ? (definition.schedule.timezone ?? null)
        : null;

    this.store.db
      .query(
        `INSERT INTO scheduled_tasks
           (id, handler, schedule_kind, schedule_value, timezone, payload_json,
            catch_up, enabled, next_run_at, last_run_at, last_error,
            failure_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           handler = excluded.handler,
           schedule_kind = excluded.schedule_kind,
           schedule_value = excluded.schedule_value,
           timezone = excluded.timezone,
           payload_json = excluded.payload_json,
           catch_up = excluded.catch_up,
           enabled = excluded.enabled,
           next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        definition.id,
        definition.handler,
        definition.schedule.kind,
        scheduleValue,
        timezone,
        JSON.stringify(definition.payload ?? {}),
        definition.catchUp ?? "run_once",
        enabled ? 1 : 0,
        nextRunAt,
        existing?.lastRunAt ?? null,
        existing?.lastError ?? null,
        existing?.failureCount ?? 0,
        createdAt,
        updatedAt,
      );
    this.reschedule();
    return this.getTask(definition.id)!;
  }

  getTask(id: string): ScheduledTask | null {
    const row = this.store.db
      .query<ScheduledTaskRow, [string]>(
        "SELECT * FROM scheduled_tasks WHERE id = ?",
      )
      .get(id);
    return row ? taskFromRow(row) : null;
  }

  listTasks(): ScheduledTask[] {
    return this.store.db
      .query<ScheduledTaskRow, []>("SELECT * FROM scheduled_tasks ORDER BY id")
      .all()
      .map(taskFromRow);
  }

  start(): void {
    if (this.closed) throw new Error("scheduler is closed");
    if (this.started) return;
    this.started = true;
    const now = this.now();
    this.skipMissedTasks(now);
    this.scheduleNextWake(now);
  }

  close(): void {
    this.closed = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runDue(now = this.now()): Promise<number> {
    if (this.closed) return 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const due = this.store.db
      .query<ScheduledTaskRow, [string]>(
        `SELECT * FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at, id`,
      )
      .all(now.toISOString())
      .map(taskFromRow)
      .filter((task) => !this.running.has(task.id));
    const executions = due.map((task) => this.execute(task));
    // execute() marks each task running synchronously before its first await.
    // Re-arm now so a slow handler never blocks unrelated future work.
    this.reschedule();
    await Promise.all(executions);
    return due.length;
  }

  private async execute(task: ScheduledTask): Promise<void> {
    this.running.add(task.id);
    try {
      const handler = this.handlers.get(task.handler);
      if (!handler) {
        throw new Error(`no scheduled task handler ${JSON.stringify(task.handler)}`);
      }
      await handler(task.payload, task);
      const finishedAt = this.now();
      const next = nextOccurrence(task.schedule, finishedAt);
      this.store.db
        .query(
          `UPDATE scheduled_tasks SET
             next_run_at = ?, last_run_at = ?, last_error = NULL,
             failure_count = 0, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next?.toISOString() ?? null,
          finishedAt.toISOString(),
          finishedAt.toISOString(),
          task.id,
        );
    } catch (error) {
      const failedAt = this.now();
      const failures = task.failureCount + 1;
      const retryMs = Math.min(
        DEFAULT_RETRY_MS * 2 ** Math.min(failures - 1, 6),
        MAX_RETRY_MS,
      );
      this.store.db
        .query(
          `UPDATE scheduled_tasks SET
             next_run_at = ?, last_error = ?, failure_count = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          new Date(failedAt.getTime() + retryMs).toISOString(),
          error instanceof Error ? error.message : String(error),
          failures,
          failedAt.toISOString(),
          task.id,
        );
      console.error(`Scheduled task ${task.id} failed`, error);
    } finally {
      this.running.delete(task.id);
      // The completed task now has a fresh next_run_at (or retry), so fold it
      // back into the earliest-due wake without disturbing other live tasks.
      this.reschedule();
    }
  }

  private skipMissedTasks(now: Date): void {
    const missed = this.store.db
      .query<ScheduledTaskRow, [string]>(
        `SELECT * FROM scheduled_tasks
         WHERE enabled = 1 AND catch_up = 'skip'
           AND next_run_at IS NOT NULL AND next_run_at <= ?`,
      )
      .all(now.toISOString())
      .map(taskFromRow);
    for (const task of missed) {
      const next = nextOccurrence(task.schedule, now);
      this.store.db
        .query(
          "UPDATE scheduled_tasks SET next_run_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(next?.toISOString() ?? null, now.toISOString(), task.id);
    }
  }

  private reschedule(): void {
    if (this.closed || !this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.scheduleNextWake(this.now());
  }

  private scheduleNextWake(now: Date): void {
    if (this.closed || !this.started || this.timer) return;
    const rows = this.store.db
      .query<{ id: string; next_run_at: string }, []>(
        `SELECT id, next_run_at FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL
         ORDER BY next_run_at, id`,
      )
      .all();
    const row = rows.find((candidate) => !this.running.has(candidate.id));
    if (!row) return;
    const delay = Math.max(
      1,
      Math.min(Date.parse(row.next_run_at) - now.getTime(), MAX_TIMER_MS),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runDue().catch((error) =>
        console.error("Scheduled task runner failed", error),
      );
    }, delay);
    this.timer.unref?.();
  }
}

export function nextOccurrence(
  schedule: TaskSchedule,
  after: Date,
): Date | null {
  if (schedule.kind === "interval") {
    if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs <= 0) {
      throw new Error("interval schedule must be a positive safe integer");
    }
    return new Date(after.getTime() + schedule.everyMs);
  }
  const cron = new Cron(schedule.expression, {
    paused: true,
    ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
  });
  try {
    return cron.nextRun(after);
  } finally {
    cron.stop();
  }
}

function validateDefinition(definition: ScheduledTaskDefinition): void {
  if (!definition.id.trim()) throw new Error("scheduled task id is required");
  if (!definition.handler.trim()) {
    throw new Error("scheduled task handler is required");
  }
  nextOccurrence(definition.schedule, new Date());
  JSON.stringify(definition.payload ?? {});
}

function sameSchedule(a: TaskSchedule, b: TaskSchedule): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "interval" && b.kind === "interval") {
    return a.everyMs === b.everyMs;
  }
  if (a.kind === "cron" && b.kind === "cron") {
    return a.expression === b.expression && a.timezone === b.timezone;
  }
  return false;
}

function taskFromRow(row: ScheduledTaskRow): ScheduledTask {
  const schedule: TaskSchedule =
    row.schedule_kind === "interval"
      ? { kind: "interval", everyMs: Number(row.schedule_value) }
      : {
          kind: "cron",
          expression: row.schedule_value,
          ...(row.timezone ? { timezone: row.timezone } : {}),
        };
  return {
    id: row.id,
    handler: row.handler,
    schedule,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    catchUp: row.catch_up === "skip" ? "skip" : "run_once",
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    failureCount: row.failure_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
