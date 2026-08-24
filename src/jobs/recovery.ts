import type { PhiStore } from "../db/store.ts";
import type { GitService } from "../workspace/git.ts";
import type { WorkerAdapterRegistry } from "../workers/adapter.ts";
import type { CompletionService } from "./completion.ts";
import type { JobScheduler } from "./scheduler.ts";

export class RecoveryService {
  constructor(
    private readonly options: {
      store: PhiStore;
      adapters: WorkerAdapterRegistry;
      completion: CompletionService;
      scheduler: JobScheduler;
      git: GitService;
    },
  ) {}

  async recover(): Promise<void> {
    this.options.store.recoverClaims();
    for (const job of this.options.store.listJobs([
      "launching",
      "running",
      "cancelling",
    ])) {
      const adapter = this.options.adapters.get(job.adapter);
      const result = await adapter.reconcile({
        dispatchKey: job.dispatchKey,
        ...(job.externalRunId ? { externalRunId: job.externalRunId } : {}),
      });
      if (result.state === "terminal")
        await this.options.completion.observe(job, result.event);
      else if (result.state === "running") {
        const running =
          job.status === "launching"
            ? this.options.store.recordRunning(
                job.id,
                result.externalRunId,
                result.continuationHandle,
              )
            : this.options.store.getJob(job.id);
        void this.options.scheduler.watch(running);
      } else
        this.options.store.markUnknown(
          job.id,
          result.state === "not_found"
            ? "adapter could not find the accepted launch"
            : result.reason,
        );
    }
    for (const job of this.options.store.listJobs(["completing"])) {
      const event = this.options.store
        .listEvents()
        .find(
          (candidate) =>
            candidate.jobId === job.id &&
            candidate.visibleAt === null &&
            candidate.kind.startsWith("worker_"),
        );
      if (!event) {
        this.options.store.markUnknown(
          job.id,
          "completing job has no terminal event",
        );
        continue;
      }
      const status =
        event.kind === "worker_completed"
          ? "completed"
          : event.kind === "worker_cancelled"
            ? "cancelled"
            : "failed";
      const checkpoint = await this.options.git.checkpoint({
        triggerJobId: job.id,
        status,
        checkpointId: event.id,
      });
      if (checkpoint.commit && checkpoint.checkpointId)
        this.options.store.recordCheckpoint({
          id: checkpoint.checkpointId,
          workspaceId: job.workspaceId,
          commitSha: checkpoint.commit,
          triggerJobId: job.id,
          status,
        });
      this.options.store.finalizeCompletion({
        jobId: job.id,
        eventId: event.id,
        status,
        observedTerminalCommit: checkpoint.commit,
        ...(status === "failed"
          ? { error: String(event.payload.error ?? "worker failed") }
          : {}),
      });
    }
  }
}
