import { DrainLoop } from "../drain-loop.ts";
import type { PhiStore } from "../db/store.ts";
import { terminalJobStatuses, type JobRecord } from "../domain.ts";
import { buildWorkerBrief } from "../workspace/instructions.ts";
import type { WorkerAdapterRegistry } from "../workers/adapter.ts";
import type { CompletionService } from "./completion.ts";

export class JobScheduler {
  private active = 0;
  private readonly watched = new Set<string>();
  private readonly loop: DrainLoop;

  constructor(
    private readonly options: {
      store: PhiStore;
      adapters: WorkerAdapterRegistry;
      completion: CompletionService;
      workspace: string;
      concurrency: number;
    },
  ) {
    this.loop = new DrainLoop(() => this.drainOnce());
  }

  start(): void {
    this.loop.start();
  }
  stop(): void {
    this.loop.stop();
  }
  isIdle(): boolean {
    return this.loop.isIdle();
  }
  wake(): void {
    this.loop.wake();
  }

  private async drainOnce(): Promise<boolean> {
    if (this.active >= this.options.concurrency) return false;
    const job = this.options.store.claimNextJob();
    if (!job) return false;
    this.active += 1;
    void this.launch(job).finally(() => {
      this.active -= 1;
      this.wake();
    });
    return true;
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
        ...(job.model ? { model: job.model } : {}),
        ...(job.effort ? { effort: job.effort } : {}),
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
      } else if (!terminalJobStatuses.has(current.status))
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
        !terminalJobStatuses.has(current.status) &&
        current.status !== "unknown"
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
