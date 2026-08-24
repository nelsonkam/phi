import type { PhiStore } from "../db/store.ts";
import type { JobRecord } from "../domain.ts";
import type { GitService } from "../workspace/git.ts";
import { buildWorkerBrief } from "../workspace/instructions.ts";
import type { WorkerAdapterRegistry } from "../workers/adapter.ts";
import type { CompletionService } from "./completion.ts";

export class JobScheduler {
  private active = 0;
  private stopped = false;
  private draining = false;
  private wakePending = false;
  private readonly watched = new Set<string>();

  constructor(
    private readonly options: {
      store: PhiStore;
      adapters: WorkerAdapterRegistry;
      completion: CompletionService;
      git: GitService;
      workspace: string;
      concurrency: number;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.wake();
  }
  stop(): void {
    this.stopped = true;
  }
  isIdle(): boolean {
    return !this.draining && !this.wakePending;
  }
  wake(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.wakePending = true;
      return;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.stopped && this.active < this.options.concurrency) {
        const revision = await this.options.git.currentRevision();
        if (this.stopped) break;
        const job = this.options.store.claimNextJob(revision);
        if (!job) break;
        this.active += 1;
        void this.launch(job).finally(() => {
          this.active -= 1;
          this.wake();
        });
      }
    } finally {
      this.draining = false;
      if (this.wakePending) {
        this.wakePending = false;
        this.wake();
      }
    }
  }

  private async launch(job: JobRecord): Promise<void> {
    try {
      const adapter = this.options.adapters.get(job.adapter);
      const launched = await adapter.launch({
        jobId: job.id,
        dispatchKey: job.dispatchKey,
        prompt: buildWorkerBrief({
          workspace: this.options.workspace,
          prompt: job.prompt,
          jobId: job.id,
          dispatchKey: job.dispatchKey,
          mode: job.mode,
        }),
        cwd: this.options.workspace,
        mode: job.mode,
      });
      const running = this.options.store.recordRunning(
        job.id,
        launched.externalRunId,
        launched.continuationHandle,
      );
      await this.watch(running);
    } catch (error) {
      const current = this.options.store.getJob(job.id);
      if (current.status === "launching") {
        await this.options.completion.observe(current, {
          type: "failed",
          nativeId: "launch",
          error: error instanceof Error ? error.message : String(error),
        });
      } else if (!["completed", "failed", "cancelled"].includes(current.status))
        this.options.store.markUnknown(
          job.id,
          error instanceof Error ? error.message : String(error),
        );
    }
  }

  async watch(job: JobRecord): Promise<void> {
    if (!job.externalRunId || this.watched.has(job.externalRunId)) return;
    this.watched.add(job.externalRunId);
    try {
      const adapter = this.options.adapters.get(job.adapter);
      for await (const event of adapter.watch(job.externalRunId)) {
        const terminal = await this.options.completion.observe(
          this.options.store.getJob(job.id),
          event,
        );
        if (terminal) break;
      }
    } catch (error) {
      const current = this.options.store.getJob(job.id);
      if (
        !["completed", "failed", "cancelled", "unknown"].includes(
          current.status,
        )
      )
        this.options.store.markUnknown(
          job.id,
          `watch disconnected: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
      this.watched.delete(job.externalRunId);
    }
  }
}
