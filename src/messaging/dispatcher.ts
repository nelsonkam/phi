import { DrainLoop } from "../drain-loop.ts";
import type { PhiStore } from "../db/store.ts";
import type { MessageTransport } from "./transport.ts";

export class OutboxDispatcher {
  private readonly loop: DrainLoop;
  constructor(
    private readonly store: PhiStore,
    private readonly transport: MessageTransport,
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
    const message = this.store.claimOutbox();
    if (!message) return false;
    try {
      await this.transport.deliver({
        id: message.id,
        idempotencyKey: message.idempotencyKey,
        kind: message.kind,
        content: message.content,
      });
      this.store.settleOutbox(message.id);
    } catch (error) {
      this.store.settleOutbox(
        message.id,
        error instanceof Error ? error.message : String(error),
      );
    }
    return true;
  }
}
