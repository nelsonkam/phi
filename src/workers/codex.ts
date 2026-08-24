import { Codex, type Thread, type ThreadEvent } from "@openai/codex-sdk";
import { mkdirSync } from "node:fs";
import { UnsupportedCapabilityError } from "../errors.ts";
import {
  AsyncQueue,
  type WorkerAdapter,
  type WorkerEvent,
  type WorkerReconciliation,
} from "./adapter.ts";

interface CodexRun {
  thread: Thread;
  controller: AbortController;
  queue: AsyncQueue<WorkerEvent>;
  terminal?: WorkerEvent;
}

export class CodexWorkerAdapter implements WorkerAdapter {
  readonly id = "codex";
  readonly capabilities = {
    watch: "live",
    continuation: "sequential",
    cancellation: "abort",
    reconciliation: "none",
    reasoning: "summary",
    toolEvents: true,
    needsInput: false,
    isolation: "optional_sdk_sandbox",
  } as const;
  private readonly runs = new Map<string, CodexRun>();
  private readonly codex: Codex;

  constructor(
    private readonly options: {
      codexHome?: string;
      apiKey?: string;
      model?: string;
    },
  ) {
    if (options.codexHome)
      mkdirSync(options.codexHome, { recursive: true, mode: 0o700 });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    if (options.codexHome) env.CODEX_HOME = options.codexHome;
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.codex = new Codex({ env, ...(apiKey ? { apiKey } : {}) });
  }

  async launch(input: {
    prompt: string;
    cwd: string;
    mode: "read_only" | "mutating";
  }): Promise<{ externalRunId: string; continuationHandle: string }> {
    const thread = this.codex.startThread({
      workingDirectory: input.cwd,
      skipGitRepoCheck: false,
      sandboxMode: input.mode === "read_only" ? "read-only" : "workspace-write",
      approvalPolicy: "never",
      ...(this.options.model ? { model: this.options.model } : {}),
    });
    const controller = new AbortController();
    const queue = new AsyncQueue<WorkerEvent>();
    const record: CodexRun = { thread, controller, queue };
    const started = Promise.withResolvers<string>();
    void this.pump(record, input.prompt, started);
    const threadId = await Promise.race([
      started.promise,
      Bun.sleep(30_000).then(() => {
        throw new Error("Codex SDK did not emit a thread id within 30 seconds");
      }),
    ]);
    this.runs.set(threadId, record);
    return { externalRunId: threadId, continuationHandle: threadId };
  }

  private map(event: ThreadEvent): WorkerEvent | null {
    if (event.type === "thread.started")
      return {
        type: "activity",
        nativeId: event.thread_id,
        category: "status",
        message: "Codex thread started",
      };
    if (event.type === "turn.completed")
      return {
        type: "completed",
        nativeId: "turn.completed",
        summary: "Codex turn completed",
        data: { usage: event.usage },
      };
    if (event.type === "turn.failed")
      return {
        type: "failed",
        nativeId: "turn.failed",
        error: event.error.message,
      };
    if (event.type === "error") return { type: "failed", error: event.message };
    if (event.type === "turn.started")
      return {
        type: "activity",
        category: "status",
        message: "Codex turn started",
      };
    const item = event.item;
    if (item.type === "agent_message")
      return {
        type: "activity",
        nativeId: item.id,
        category: "assistant",
        message: item.text,
      };
    if (item.type === "reasoning")
      return {
        type: "activity",
        nativeId: item.id,
        category: "reasoning",
        message: item.text,
      };
    if (item.type === "command_execution")
      return {
        type: "activity",
        nativeId: item.id,
        category: "tool",
        message: `${item.command}: ${item.status}`,
        data: { exitCode: item.exit_code },
      };
    if (item.type === "file_change")
      return {
        type: "activity",
        nativeId: item.id,
        category: "tool",
        message: `file change: ${item.status}`,
        data: { changes: item.changes },
      };
    if (item.type === "mcp_tool_call")
      return {
        type: "activity",
        nativeId: item.id,
        category: "tool",
        message: `${item.server}/${item.tool}: ${item.status}`,
      };
    if (item.type === "web_search")
      return {
        type: "activity",
        nativeId: item.id,
        category: "tool",
        message: `web search: ${item.query}`,
      };
    if (item.type === "todo_list")
      return {
        type: "activity",
        nativeId: item.id,
        category: "status",
        message: item.items
          .map((todo) => `${todo.completed ? "✓" : "·"} ${todo.text}`)
          .join("; "),
      };
    return {
      type: "activity",
      nativeId: item.id,
      category: "status",
      message: item.message,
    };
  }

  private async pump(
    record: CodexRun,
    prompt: string,
    started: PromiseWithResolvers<string>,
  ): Promise<void> {
    try {
      const streamed = await record.thread.runStreamed(prompt, {
        signal: record.controller.signal,
      });
      for await (const sdkEvent of streamed.events) {
        if (sdkEvent.type === "thread.started")
          started.resolve(sdkEvent.thread_id);
        const event = this.map(sdkEvent);
        if (!event) continue;
        record.queue.push(event);
        if (
          event.type === "completed" ||
          event.type === "failed" ||
          event.type === "cancelled"
        )
          record.terminal = event;
      }
      if (!record.terminal) {
        const terminal: WorkerEvent = record.controller.signal.aborted
          ? { type: "cancelled", summary: "Codex turn aborted" }
          : {
              type: "failed",
              error: "Codex stream ended without a terminal event",
            };
        record.terminal = terminal;
        record.queue.push(terminal);
      }
    } catch (error) {
      started.reject(error);
      const terminal: WorkerEvent = record.controller.signal.aborted
        ? { type: "cancelled", summary: "Codex turn aborted" }
        : {
            type: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
      record.terminal = terminal;
      record.queue.push(terminal);
    } finally {
      record.queue.close();
    }
  }

  watch(externalRunId: string): AsyncIterable<WorkerEvent> {
    const record = this.runs.get(externalRunId);
    if (!record)
      throw new Error(`Codex thread is not attached: ${externalRunId}`);
    return record.queue;
  }
  async followUp(): Promise<void> {
    throw new UnsupportedCapabilityError(
      "Codex supports sequential thread continuation, but Phi follow-up is reserved for an active needs-input turn",
    );
  }
  async cancel(externalRunId: string): Promise<void> {
    const record = this.runs.get(externalRunId);
    if (!record)
      throw new UnsupportedCapabilityError(
        "Codex cancellation requires the live SDK turn AbortSignal",
      );
    record.controller.abort();
  }
  async reconcile(): Promise<WorkerReconciliation> {
    return {
      state: "unavailable",
      reason:
        "Codex SDK can resume a thread for a new turn but cannot authoritatively inspect an interrupted turn by dispatch key",
    };
  }
}
