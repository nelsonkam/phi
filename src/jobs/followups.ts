import type { PhiStore } from "../db/store.ts";
import type { WorkerAdapterRegistry } from "../workers/adapter.ts";

export class FollowUpDispatcher {
  private stopped = false;
  private draining = false;
  private wakePending = false;
  constructor(
    private readonly store: PhiStore,
    private readonly adapters: WorkerAdapterRegistry,
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
      while (!this.stopped) {
        const followUp = this.store.claimFollowUp();
        if (!followUp) break;
        const job = this.store.getJob(followUp.jobId);
        if (job.status !== "needs_input") {
          this.store.settleFollowUp(followUp.id, "stale");
          continue;
        }
        try {
          await this.adapters
            .get(job.adapter)
            .followUp(followUp.continuationHandle, followUp.content);
          this.store.settleFollowUp(followUp.id, "sent");
        } catch (error) {
          this.store.settleFollowUp(
            followUp.id,
            "unknown",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      this.draining = false;
      if (this.wakePending) {
        this.wakePending = false;
        this.wake();
      }
    }
  }
}
