import { UnsupportedCapabilityError } from "../errors.ts";
import { newId } from "../ids.ts";
import {
  AsyncQueue,
  type WorkerAdapter,
  type WorkerEvent,
  type WorkerReconciliation,
} from "./adapter.ts";

interface FakeRun {
  id: string;
  dispatchKey: string;
  queue: AsyncQueue<WorkerEvent>;
  cancelled: boolean;
  terminal?: WorkerEvent;
  pendingQuestion?: { resolve: (text: string) => void };
}

export class FakeWorkerAdapter implements WorkerAdapter {
  readonly id = "fake";
  readonly capabilities = {
    watch: "live",
    continuation: "in_run",
    cancellation: "abort",
    reconciliation: "dispatch_key",
    reasoning: "summary",
    toolEvents: true,
    needsInput: true,
    isolation: "none",
  } as const;
  private readonly runs = new Map<string, FakeRun>();

  async launch(input: {
    dispatchKey: string;
    prompt: string;
  }): Promise<{ externalRunId: string; continuationHandle: string }> {
    const existing = [...this.runs.values()].find(
      (run) => run.dispatchKey === input.dispatchKey,
    );
    if (existing)
      return { externalRunId: existing.id, continuationHandle: existing.id };
    const id = `fake-${newId()}`;
    const run: FakeRun = {
      id,
      dispatchKey: input.dispatchKey,
      queue: new AsyncQueue(),
      cancelled: false,
    };
    this.runs.set(id, run);
    void this.execute(run, input.prompt);
    return { externalRunId: id, continuationHandle: id };
  }

  private async execute(run: FakeRun, prompt: string): Promise<void> {
    const delay = Number(/\[fake:delay=(\d+)\]/.exec(prompt)?.[1] ?? "5");
    await Bun.sleep(delay);
    if (run.cancelled) return;
    run.queue.push({
      type: "activity",
      nativeId: "start",
      category: "status",
      message: "fake worker started",
    });
    if (prompt.includes("[fake:needs_input]")) {
      const answer = await new Promise<string>((resolve) => {
        run.pendingQuestion = { resolve };
        run.queue.push({
          type: "needs_input",
          nativeId: "question",
          question: "Provide the deterministic fake answer.",
          continuationHandle: run.id,
        });
      });
      run.queue.push({
        type: "activity",
        nativeId: "follow-up",
        category: "assistant",
        message: `received: ${answer}`,
      });
    }
    if (run.cancelled) return;
    const terminal: WorkerEvent = prompt.includes("[fake:fail]")
      ? {
          type: "failed",
          nativeId: "terminal",
          error: "deterministic fake failure",
        }
      : {
          type: "completed",
          nativeId: "terminal",
          summary: "deterministic fake completion",
          data: { prompt },
        };
    run.terminal = terminal;
    run.queue.push(terminal);
    if (prompt.includes("[fake:duplicate]")) run.queue.push(terminal);
    run.queue.close();
  }

  watch(externalRunId: string): AsyncIterable<WorkerEvent> {
    const run = this.runs.get(externalRunId);
    if (!run) throw new Error(`fake run not found: ${externalRunId}`);
    return run.queue;
  }

  async followUp(handle: string, text: string): Promise<void> {
    const run = this.runs.get(handle);
    if (!run?.pendingQuestion)
      throw new UnsupportedCapabilityError(
        `fake run ${handle} is not awaiting input`,
      );
    const pending = run.pendingQuestion;
    delete run.pendingQuestion;
    pending.resolve(text);
  }

  async cancel(externalRunId: string): Promise<void> {
    const run = this.runs.get(externalRunId);
    if (!run || run.terminal) return;
    run.cancelled = true;
    const terminal: WorkerEvent = {
      type: "cancelled",
      nativeId: "cancelled",
      summary: "fake run cancelled",
    };
    run.terminal = terminal;
    run.queue.push(terminal);
    run.queue.close();
  }

  async reconcile(input: {
    dispatchKey: string;
    externalRunId?: string;
  }): Promise<WorkerReconciliation> {
    const run = input.externalRunId
      ? this.runs.get(input.externalRunId)
      : [...this.runs.values()].find(
          (candidate) => candidate.dispatchKey === input.dispatchKey,
        );
    if (!run) return { state: "not_found" };
    if (run.terminal) return { state: "terminal", event: run.terminal };
    return {
      state: "running",
      externalRunId: run.id,
      continuationHandle: run.id,
    };
  }
}
