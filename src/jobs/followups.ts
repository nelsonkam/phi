import { DrainLoop } from "../drain-loop.ts";
import type { PhiStore } from "../db/store.ts";
import type { WorkerAdapterRegistry } from "../workers/adapter.ts";

export class FollowUpDispatcher {
  private readonly loop: DrainLoop;
  constructor(
    private readonly store: PhiStore,
    private readonly adapters: WorkerAdapterRegistry,
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
    const followUp = this.store.claimFollowUp();
    if (!followUp) return false;
    const job = this.store.getJob(followUp.jobId);
    if (job.status !== "needs_input") {
      this.store.settleFollowUp(followUp.id, "stale");
      return true;
    }
    const adapter = this.adapters.get(job.adapter);
    if (!adapter.followUp) {
      this.store.settleFollowUp(
        followUp.id,
        "unknown",
        `${job.adapter} does not expose follow-up`,
      );
      return true;
    }
    try {
      await adapter.followUp(followUp.continuationHandle, followUp.content);
      this.store.settleFollowUp(followUp.id, "sent");
    } catch (error) {
      this.store.settleFollowUp(
        followUp.id,
        "unknown",
        error instanceof Error ? error.message : String(error),
      );
    }
    return true;
  }
}
