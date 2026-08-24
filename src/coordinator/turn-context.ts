import type { EventRecord } from "../domain.ts";

export class TurnContext {
  private current: EventRecord | null = null;
  async run<T>(event: EventRecord, fn: () => Promise<T>): Promise<T> {
    if (this.current) throw new Error("coordinator turns are serial");
    this.current = event;
    try {
      return await fn();
    } finally {
      this.current = null;
    }
  }
  require(): EventRecord {
    if (!this.current)
      throw new Error("Phi tool called outside a durable coordinator turn");
    return this.current;
  }
}
