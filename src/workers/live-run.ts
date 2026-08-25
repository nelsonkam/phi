import { AsyncQueue, type WorkerEvent } from "./adapter.ts";

export interface LiveRun {
  queue: AsyncQueue<WorkerEvent>;
  terminal?: WorkerEvent;
}

function isTerminal(event: WorkerEvent): boolean {
  return (
    event.type === "completed" ||
    event.type === "failed" ||
    event.type === "cancelled"
  );
}

export function createLiveRun(): LiveRun {
  return { queue: new AsyncQueue() };
}

export async function awaitStartId(
  started: Promise<string>,
  label: string,
  timeoutMs = 30_000,
): Promise<string> {
  return Promise.race([
    started,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`${label} within ${timeoutMs / 1000} seconds`);
    }),
  ]);
}

export class LiveRunTable<T extends LiveRun> {
  private readonly runs = new Map<string, T>();

  constructor(private readonly label: string) {}

  set(id: string, record: T): void {
    this.runs.set(id, record);
  }

  get(id: string): T | undefined {
    return this.runs.get(id);
  }

  require(id: string): T {
    const record = this.runs.get(id);
    if (!record) throw new Error(`${this.label} is not attached: ${id}`);
    return record;
  }

  watch(id: string): AsyncIterable<WorkerEvent> {
    return this.require(id).queue;
  }

  emit(record: T, event: WorkerEvent): void {
    if (isTerminal(event)) {
      if (record.terminal) return;
      record.terminal = event;
    }
    record.queue.push(event);
  }

  finishStream(
    record: T,
    aborted: boolean,
    messages: { cancelled: string; failed: string },
    error?: unknown,
  ): void {
    if (!record.terminal) {
      const terminal: WorkerEvent = aborted
        ? { type: "cancelled", summary: messages.cancelled }
        : error !== undefined
          ? {
              type: "failed",
              error: error instanceof Error ? error.message : String(error),
            }
          : { type: "failed", error: messages.failed };
      this.emit(record, terminal);
    }
    record.queue.close();
  }
}
