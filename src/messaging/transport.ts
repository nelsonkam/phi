import type { MessageKind } from "../domain.ts";

export interface MessageTransport {
  readonly id: string;
  deliver(message: {
    id: string;
    idempotencyKey: string;
    kind: MessageKind;
    content: string;
  }): Promise<void>;
}

export class ConsoleTransport implements MessageTransport {
  readonly id = "console";
  private readonly delivered = new Set<string>();
  async deliver(message: {
    idempotencyKey: string;
    kind: MessageKind;
    content: string;
  }): Promise<void> {
    if (this.delivered.has(message.idempotencyKey)) return;
    this.delivered.add(message.idempotencyKey);
    process.stdout.write(`\n[phi:${message.kind}] ${message.content}\n`);
  }
}

export class MemoryTransport implements MessageTransport {
  readonly id = "memory";
  readonly messages: Array<{
    id: string;
    idempotencyKey: string;
    kind: MessageKind;
    content: string;
  }> = [];
  async deliver(message: {
    id: string;
    idempotencyKey: string;
    kind: MessageKind;
    content: string;
  }): Promise<void> {
    if (
      !this.messages.some(
        (item) => item.idempotencyKey === message.idempotencyKey,
      )
    )
      this.messages.push(message);
  }
}
