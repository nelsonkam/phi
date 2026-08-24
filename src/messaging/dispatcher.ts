import type { PhiStore } from "../db/store.ts";
import type { MessageTransport } from "./transport.ts";

export class OutboxDispatcher {
  private stopped = false;
  private draining = false;
  private wakePending = false;
  constructor(
    private readonly store: PhiStore,
    private readonly transport: MessageTransport,
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
  async drainOnce(): Promise<boolean> {
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
  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.stopped && (await this.drainOnce())) {}
    } finally {
      this.draining = false;
      if (this.wakePending) {
        this.wakePending = false;
        this.wake();
      }
    }
  }
}
