import type { PhiStore } from "../db/store.ts";
import type { CoordinatorRuntime } from "./runtime.ts";
import type { TurnContext } from "./turn-context.ts";

export class CoordinatorLoop {
  private stopped = false;
  private draining = false;
  private wakePending = false;
  constructor(
    private readonly store: PhiStore,
    private readonly runtime: CoordinatorRuntime,
    private readonly turn: TurnContext,
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
  async submitUserMessage(
    text: string,
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    const event = this.store.acceptUserMessage(text, metadata);
    this.wake();
    return event.id;
  }
  async drainOnce(): Promise<boolean> {
    const event = this.store.claimNextEvent();
    if (!event) return false;
    try {
      await this.turn.run(event, () => this.runtime.prompt(event));
      this.store.markEventProcessed(event.id);
    } catch (error) {
      this.store.releaseEvent(
        event.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return true;
  }
  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.stopped && (await this.drainOnce())) {}
    } catch (error) {
      process.stderr.write(
        `\n[phi:coordinator-error] ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      this.draining = false;
      if (this.wakePending) {
        this.wakePending = false;
        this.wake();
      }
    }
  }
}
