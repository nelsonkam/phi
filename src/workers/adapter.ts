import type { JobMode } from "../domain.ts";

export interface AdapterCapabilities {
  watch: "live" | "terminal_only";
  continuation: "none" | "sequential" | "in_run";
  cancellation: "none" | "abort" | "remote";
  reconciliation: "none" | "external_run_id" | "dispatch_key";
  reasoning: "none" | "summary";
  toolEvents: boolean;
  needsInput: boolean;
  isolation: "none" | "optional_sdk_sandbox" | "remote_sandbox";
}

export type WorkerEvent =
  | {
      type: "activity";
      nativeId?: string;
      category: "assistant" | "reasoning" | "tool" | "status" | "usage";
      message: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "needs_input";
      nativeId?: string;
      question: string;
      continuationHandle: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "completed";
      nativeId?: string;
      summary: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "failed";
      nativeId?: string;
      error: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "cancelled";
      nativeId?: string;
      summary: string;
      data?: Record<string, unknown>;
    };

export type WorkerReconciliation =
  | { state: "running"; externalRunId: string; continuationHandle?: string }
  | { state: "terminal"; event: WorkerEvent }
  | { state: "not_found" }
  | { state: "unavailable"; reason: string };

export interface WorkerAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  launch(input: {
    jobId: string;
    dispatchKey: string;
    prompt: string;
    cwd: string;
    mode: JobMode;
  }): Promise<{ externalRunId: string; continuationHandle?: string }>;
  watch(externalRunId: string): AsyncIterable<WorkerEvent>;
  followUp(continuationHandle: string, text: string): Promise<void>;
  cancel(externalRunId: string): Promise<void>;
  reconcile(input: {
    dispatchKey: string;
    externalRunId?: string;
  }): Promise<WorkerReconciliation>;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export class WorkerAdapterRegistry {
  private readonly adapters = new Map<string, WorkerAdapter>();
  register(adapter: WorkerAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string): WorkerAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`unknown worker adapter: ${id}`);
    return adapter;
  }
  list(): WorkerAdapter[] {
    return [...this.adapters.values()];
  }
}
