import type { JobMode, WorkerEffort } from "../domain.ts";

export interface AdapterCapabilities {
  followUp: boolean;
  cancel: boolean;
}

export interface WorkerModelDescriptor {
  id: string;
  label: string;
  effortLevels: WorkerEffort[];
}

export interface WorkerModelCatalog {
  defaultModel: string | null;
  models: WorkerModelDescriptor[];
  defaultEffortLevels: WorkerEffort[];
  note?: string;
}

export type WorkerReadiness = "ready" | "login_required" | "unverified";

export function buildModelCatalog(input: {
  defaultModel: string | null;
  ids: string[];
  effortLevels: WorkerEffort[];
  label?: (id: string) => string;
  note?: string;
}): WorkerModelCatalog {
  return {
    defaultModel: input.defaultModel,
    models: [...new Set(input.ids)].map((id) => ({
      id,
      label: input.label?.(id) ?? id,
      effortLevels: input.effortLevels,
    })),
    defaultEffortLevels: input.effortLevels,
    ...(input.note ? { note: input.note } : {}),
  };
}

export interface WorkerStatus {
  readiness: WorkerReadiness;
  detail: string;
  interactiveAuth: boolean;
}

export interface WorkerDescriptor extends WorkerStatus {
  id: string;
  capabilities: AdapterCapabilities;
  modelCatalog: WorkerModelCatalog;
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
    model?: string;
    effort?: WorkerEffort;
  }): Promise<{ externalRunId: string; continuationHandle?: string }>;
  watch(externalRunId: string): AsyncIterable<WorkerEvent>;
  followUp?(continuationHandle: string, text: string): Promise<void>;
  cancel(externalRunId: string): Promise<void>;
  reconcile?(input: {
    dispatchKey: string;
    externalRunId?: string;
    model?: string;
    effort?: WorkerEffort;
  }): Promise<WorkerReconciliation>;
  modelCatalog(): Promise<WorkerModelCatalog>;
  status?(): Promise<WorkerStatus>;
  authenticate?(options?: {
    onLoginUrl?: (url: string) => void;
    signal?: AbortSignal;
  }): Promise<WorkerStatus>;
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
  async describeAll(): Promise<WorkerDescriptor[]> {
    return Promise.all(
      this.list().map(async (adapter) => {
        let status: WorkerStatus;
        try {
          status = adapter.status
            ? await adapter.status()
            : {
                readiness: "unverified",
                detail: "authentication is checked when a job launches",
                interactiveAuth: false,
              };
        } catch (error) {
          status = {
            readiness: "unverified",
            detail: `status check failed: ${error instanceof Error ? error.message : String(error)}`,
            interactiveAuth: Boolean(adapter.authenticate),
          };
        }
        let modelCatalog: WorkerModelCatalog;
        try {
          modelCatalog = await adapter.modelCatalog();
        } catch (error) {
          modelCatalog = {
            defaultModel: null,
            models: [],
            defaultEffortLevels: [],
            note: `model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        return {
          id: adapter.id,
          capabilities: adapter.capabilities,
          modelCatalog,
          ...status,
        };
      }),
    );
  }

  async resolveSelection(
    id: string,
    input: { model?: string; effort?: WorkerEffort },
  ): Promise<{ model?: string; effort?: WorkerEffort }> {
    const adapter = this.get(id);
    const catalog = await adapter.modelCatalog();
    const model = input.model ?? catalog.defaultModel ?? undefined;
    const descriptor = model
      ? catalog.models.find((candidate) => candidate.id === model)
      : undefined;
    if (model && !descriptor)
      throw new Error(
        `${id} model is not selectable: ${model}; call list_workers for the current catalog`,
      );
    const effortLevels =
      descriptor?.effortLevels ?? catalog.defaultEffortLevels;
    if (input.effort && !effortLevels.includes(input.effort))
      throw new Error(
        `${id} effort ${input.effort} is not supported${model ? ` by ${model}` : " by its default model"}`,
      );
    return {
      ...(model ? { model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    };
  }
  async authenticate(
    id: string,
    options?: {
      onLoginUrl?: (url: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<WorkerStatus> {
    const adapter = this.get(id);
    if (!adapter.authenticate)
      throw new Error(`${id} does not expose interactive SDK authentication`);
    return adapter.authenticate(options);
  }
}
