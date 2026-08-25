import type { PhiStore } from "../db/store.ts";
import { terminalJobStatuses, type JobRecord } from "../domain.ts";
import { workerDedupeKey } from "../ids.ts";
import type { GitService } from "../workspace/git.ts";
import type { WorkerEvent } from "../workers/adapter.ts";

export class CompletionService {
  constructor(
    private readonly store: PhiStore,
    private readonly git: GitService,
    private readonly workspaceId: string,
    private readonly wakeCoordinator: () => void,
  ) {}

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
    const status =
      event.type === "completed"
        ? "completed"
        : event.type === "failed"
          ? "failed"
          : "cancelled";
    const checkpoint = await this.git.checkpoint({
      triggerJobId: job.id,
      status,
      checkpointId: begun.event.id,
    });
    if (checkpoint.commit && checkpoint.checkpointId)
      this.store.recordCheckpoint({
        id: checkpoint.checkpointId,
        workspaceId: this.workspaceId,
        commitSha: checkpoint.commit,
        triggerJobId: job.id,
        status,
      });
    this.store.finalizeCompletion({
      jobId: job.id,
      eventId: begun.event.id,
      status,
      observedTerminalCommit: checkpoint.commit,
      ...(event.type === "failed" ? { error: event.error } : {}),
    });
    this.wakeCoordinator();
    return true;
  }
}
