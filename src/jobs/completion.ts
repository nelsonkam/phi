import type { PhiStore } from "../db/store.ts";
import {
  terminalJobStatuses,
  type EventRecord,
  type JobRecord,
} from "../domain.ts";
import { workerDedupeKey } from "../ids.ts";
import type { GitService } from "../workspace/git.ts";
import type { WorkerEvent } from "../workers/adapter.ts";

export class CompletionService {
  constructor(
    private readonly store: PhiStore,
    private readonly git: GitService,
    private readonly wakeCoordinator: () => void,
  ) {}

  /**
   * Durably closes a job around a terminal worker event: checkpoint the
   * workspace, then reveal the terminal event. Shared by live observation
   * and startup recovery.
   */
  async finalize(job: JobRecord, event: EventRecord): Promise<void> {
    const status =
      event.kind === "worker_completed"
        ? "completed"
        : event.kind === "worker_cancelled"
          ? "cancelled"
          : "failed";
    const checkpoint = await this.git.checkpoint({
      triggerJobId: job.id,
      status,
      checkpointId: event.id,
    });
    if (checkpoint.commit && checkpoint.checkpointId)
      this.store.recordCheckpoint({
        id: checkpoint.checkpointId,
        commitSha: checkpoint.commit,
        status,
      });
    this.store.finalizeCompletion({
      jobId: job.id,
      eventId: event.id,
      status,
      observedTerminalCommit: checkpoint.commit,
      ...(status === "failed"
        ? { error: String(event.payload.error ?? "worker failed") }
        : {}),
    });
  }

  async observe(job: JobRecord, event: WorkerEvent): Promise<boolean> {
    const externalRunId = job.externalRunId ?? job.dispatchKey;
    const payload =
      event.type === "activity"
        ? { category: event.category, message: event.message, ...event.data }
        : event.type === "needs_input"
          ? { question: event.question, ...event.data }
          : event.type === "failed"
            ? { error: event.error, ...event.data }
            : { summary: event.summary, ...event.data };
    const kind =
      event.type === "activity"
        ? `worker_${event.category}`
        : event.type === "needs_input"
          ? "worker_needs_input"
          : `worker_${event.type}`;
    const dedupeKey = workerDedupeKey(
      job.adapter,
      externalRunId,
      event.nativeId,
      kind,
      payload,
    );
    if (event.type === "activity") {
      this.store.recordProgress({ jobId: job.id, kind, dedupeKey, payload });
      return false;
    }
    if (event.type === "needs_input") {
      this.store.recordNeedsInput({
        jobId: job.id,
        dedupeKey,
        payload,
        continuationHandle: event.continuationHandle,
      });
      this.wakeCoordinator();
      return false;
    }
    const terminalKind =
      event.type === "completed"
        ? "worker_completed"
        : event.type === "failed"
          ? "worker_failed"
          : "worker_cancelled";
    const begun = this.store.beginCompletion({
      jobId: job.id,
      kind: terminalKind,
      dedupeKey,
      payload,
    });
    if (
      !begun.created &&
      terminalJobStatuses.has(this.store.getJob(job.id).status)
    )
      return true;
    await this.finalize(this.store.getJob(job.id), begun.event);
    this.wakeCoordinator();
    return true;
  }
}
