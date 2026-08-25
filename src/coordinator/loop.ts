import { DrainLoop } from "../drain-loop.ts";
import type { PhiStore } from "../db/store.ts";
import type { CoordinatorRuntime } from "./runtime.ts";
import type { TurnContext } from "./turn-context.ts";

export class CoordinatorLoop {
  private readonly loop: DrainLoop;
  constructor(
    private readonly store: PhiStore,
    private readonly runtime: CoordinatorRuntime,
    private readonly turn: TurnContext,
  ) {
    this.loop = new DrainLoop(
      () => this.drainOnce(),
      (error) => {
        process.stderr.write(
          `\n[phi:coordinator-error] ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
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
  async submitUserMessage(
    text: string,
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    const event = this.store.acceptUserMessage(text, metadata);
    this.wake();
    return event.id;
  }
  private async drainOnce(): Promise<boolean> {
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
}
