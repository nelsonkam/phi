import {
  query,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "node:fs";
import { UnsupportedCapabilityError } from "../errors.ts";
import {
  AsyncQueue,
  type WorkerAdapter,
  type WorkerEvent,
  type WorkerReconciliation,
} from "./adapter.ts";

interface ClaudeRun {
  query: Query;
  controller: AbortController;
  queue: AsyncQueue<WorkerEvent>;
  sessionId?: string;
  terminal?: WorkerEvent;
}

function textOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const block = value as {
    type?: string;
    text?: string;
    name?: string;
    id?: string;
  };
  return block.type === "text" && block.text ? block.text : "";
}

export class ClaudeWorkerAdapter implements WorkerAdapter {
  readonly id = "claude";
  readonly capabilities = {
    watch: "live",
    continuation: "sequential",
    cancellation: "abort",
    reconciliation: "none",
    reasoning: "none",
    toolEvents: true,
    needsInput: false,
    isolation: "none",
  } as const;
  private readonly runs = new Map<string, ClaudeRun>();

  constructor(
    private readonly options: {
      configDir?: string;
      apiKey?: string;
      nativeCredentials?: boolean;
      model?: string;
    },
  ) {
    if (options.configDir)
      mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
  }

  async launch(input: {
    prompt: string;
    cwd: string;
  }): Promise<{ externalRunId: string; continuationHandle: string }> {
    const nativeCredentials = this.options.nativeCredentials ?? true;
    if (
      !nativeCredentials &&
      !this.options.apiKey &&
      !process.env.ANTHROPIC_API_KEY &&
      !process.env.CLAUDE_CODE_OAUTH_TOKEN
    )
      throw new Error(
        "Claude isolated credential mode requires ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ~/.phi/credentials/anthropic-api-key",
      );
    const controller = new AbortController();
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: "phi-harness/0.1.0",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    };
    if (this.options.configDir) env.CLAUDE_CONFIG_DIR = this.options.configDir;
    if (this.options.apiKey) env.ANTHROPIC_API_KEY = this.options.apiKey;
    const options = {
      abortController: controller,
      cwd: input.cwd,
      env,
      executable: "bun" as const,
      includePartialMessages: false,
      settingSources: [] as [],
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
        append:
          "You are a Phi worker. Follow the delegated brief exactly and do not expose private chain-of-thought.",
      },
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      ...(this.options.model ? { model: this.options.model } : {}),
    };
    const sdkQuery = query({ prompt: input.prompt, options });
    const record: ClaudeRun = {
      query: sdkQuery,
      controller,
      queue: new AsyncQueue(),
    };
    const started = Promise.withResolvers<string>();
    void this.pump(record, started);
    const sessionId = await Promise.race([
      started.promise,
      Bun.sleep(30_000).then(() => {
        throw new Error(
          "Claude SDK did not emit a session id within 30 seconds",
        );
      }),
    ]);
    record.sessionId = sessionId;
    this.runs.set(sessionId, record);
    return { externalRunId: sessionId, continuationHandle: sessionId };
  }

  private map(message: SDKMessage): WorkerEvent[] {
    if (message.type === "assistant") {
      const events: WorkerEvent[] = [];
      for (const raw of message.message.content) {
        const block = raw as unknown as {
          type?: string;
          text?: string;
          name?: string;
          id?: string;
        };
        const text = textOf(block);
        if (text)
          events.push({
            type: "activity",
            nativeId: message.uuid,
            category: "assistant",
            message: text,
          });
        else if (block.type === "tool_use")
          events.push({
            type: "activity",
            nativeId: block.id ?? message.uuid,
            category: "tool",
            message: `${block.name ?? "tool"}: started`,
          });
      }
      return events;
    }
    if (message.type === "tool_use_summary")
      return [
        {
          type: "activity",
          nativeId: message.uuid,
          category: "tool",
          message: message.summary,
        },
      ];
    if (message.type === "tool_progress")
      return [
        {
          type: "activity",
          nativeId: message.uuid,
          category: "tool",
          message: `${message.tool_name}: ${message.elapsed_time_seconds}s`,
        },
      ];
    if (message.type === "result") {
      if (message.subtype === "success" && !message.is_error)
        return [
          {
            type: "completed",
            nativeId: message.uuid,
            summary: message.result,
            data: {
              sessionId: message.session_id,
              costUsd: message.total_cost_usd,
              usage: message.modelUsage,
            },
          },
        ];
      const errors =
        "errors" in message
          ? message.errors.join("; ")
          : "Claude execution failed";
      return [
        {
          type: "failed",
          nativeId: message.uuid,
          error: errors,
          data: { sessionId: message.session_id },
        },
      ];
    }
    if (message.type === "system" && message.subtype === "status")
      return [
        {
          type: "activity",
          nativeId: message.uuid,
          category: "status",
          message: message.status ?? "idle",
        },
      ];
    return [];
  }

  private async pump(
    record: ClaudeRun,
    started: PromiseWithResolvers<string>,
  ): Promise<void> {
    try {
      for await (const message of record.query) {
        if (
          "session_id" in message &&
          typeof message.session_id === "string" &&
          !record.sessionId
        ) {
          record.sessionId = message.session_id;
          started.resolve(message.session_id);
        }
        for (const event of this.map(message)) {
          record.queue.push(event);
          if (
            event.type === "completed" ||
            event.type === "failed" ||
            event.type === "cancelled"
          )
            record.terminal = event;
        }
      }
      if (!record.terminal) {
        const terminal: WorkerEvent = record.controller.signal.aborted
          ? { type: "cancelled", summary: "Claude query aborted" }
          : { type: "failed", error: "Claude stream ended without a result" };
        record.terminal = terminal;
        record.queue.push(terminal);
      }
    } catch (error) {
      if (!record.sessionId) started.reject(error);
      const terminal: WorkerEvent = record.controller.signal.aborted
        ? { type: "cancelled", summary: "Claude query aborted" }
        : {
            type: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
      record.terminal = terminal;
      record.queue.push(terminal);
    } finally {
      record.queue.close();
      record.query.close();
    }
  }

  watch(externalRunId: string): AsyncIterable<WorkerEvent> {
    const record = this.runs.get(externalRunId);
    if (!record)
      throw new Error(`Claude run is not attached: ${externalRunId}`);
    return record.queue;
  }
  async followUp(): Promise<void> {
    throw new UnsupportedCapabilityError(
      "Claude supports resumed sequential sessions, but the Phi in-run follow-up contract is not exposed by this adapter",
    );
  }
  async cancel(externalRunId: string): Promise<void> {
    const record = this.runs.get(externalRunId);
    if (!record)
      throw new UnsupportedCapabilityError(
        "Claude cancellation requires the live SDK Query object",
      );
    record.controller.abort();
    record.query.close();
  }
  async reconcile(): Promise<WorkerReconciliation> {
    return {
      state: "unavailable",
      reason:
        "Claude Agent SDK does not expose authoritative lookup of a local query by Phi dispatch key",
    };
  }
}
