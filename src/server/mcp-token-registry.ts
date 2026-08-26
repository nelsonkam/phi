import type { RequestId } from "@modelcontextprotocol/sdk/types.js";

export interface McpCaller {
  threadId: string;
  agentName: string;
}

interface McpSessionEntry extends McpCaller {
  sendsThisTurn: number;
  calls: Map<string, Promise<unknown>>;
}

// Process-local capability registry. Tokens are session identity, not durable
// credentials, and disappear with the ACP session or server process.
export class McpTokenRegistry {
  private readonly entries = new Map<string, McpSessionEntry>();

  mint(caller: McpCaller): string {
    const token = crypto.randomUUID();
    this.entries.set(token, {
      ...caller,
      sendsThisTurn: 0,
      calls: new Map(),
    });
    return token;
  }

  lookup(token: string): McpCaller | null {
    const entry = this.entries.get(token);
    return entry
      ? { threadId: entry.threadId, agentName: entry.agentName }
      : null;
  }

  revoke(token: string): void {
    this.entries.delete(token);
  }

  beginTurn(token: string): void {
    const entry = this.require(token);
    entry.sendsThisTurn = 0;
    entry.calls.clear();
  }

  recordSend(token: string): void {
    this.require(token).sendsThisTurn += 1;
  }

  sendCount(token: string): number {
    return this.require(token).sendsThisTurn;
  }

  runOnce<T>(
    token: string,
    operation: string,
    requestId: RequestId,
    run: () => Promise<T> | T,
  ): Promise<T> {
    const entry = this.require(token);
    const key = `${operation}:${typeof requestId}:${String(requestId)}`;
    const existing = entry.calls.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const pending = Promise.resolve().then(run);
    entry.calls.set(key, pending);
    void pending.catch(() => {
      // A failed operation did not produce a reusable result, so a transport
      // retry gets another chance. Successful calls remain cached until revoke.
      if (entry.calls.get(key) === pending) entry.calls.delete(key);
    });
    return pending;
  }

  private require(token: string): McpSessionEntry {
    const entry = this.entries.get(token);
    if (!entry) throw new Error("unknown MCP session token");
    return entry;
  }
}
