import type { PhiStore } from "../db/store.ts";
import type { WorkerAdapterRegistry } from "../workers/adapter.ts";

export class CancellationService {
  constructor(
    private readonly store: PhiStore,
    private readonly adapters: WorkerAdapterRegistry,
  ) {}
  async request(input: {
    jobId: string;
    sourceEventId: string;
    key: string;
  }): Promise<ReturnType<PhiStore["getJob"]>> {
    const job = this.store.requestCancellation(input);
    if (job.status !== "cancelling" || !job.externalRunId) return job;
    try {
      await this.adapters.get(job.adapter).cancel(job.externalRunId);
    } catch (error) {
      return this.store.markUnknown(
        job.id,
        `cancellation outcome unknown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.store.getJob(job.id);
  }
}
