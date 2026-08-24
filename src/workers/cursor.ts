import {
  Agent,
  JsonlLocalAgentStore,
  type Run,
  type SDKAgent,
  type SDKMessage,
} from "@cursor/sdk/bundled";
import { mkdirSync } from "node:fs";
import { UnsupportedCapabilityError } from "../errors.ts";
import {
  AsyncQueue,
  type WorkerAdapter,
  type WorkerEvent,
  type WorkerReconciliation,
} from "./adapter.ts";

interface CursorRun {
  agent: SDKAgent;
  run: Run;
  queue: AsyncQueue<WorkerEvent>;
  cwd: string;
  terminal?: WorkerEvent;
}

export class CursorWorkerAdapter implements WorkerAdapter {
  readonly id = "cursor";
  readonly capabilities = {
    watch: "live",
    continuation: "sequential",
    cancellation: "remote",
    reconciliation: "external_run_id",
    reasoning: "summary",
    toolEvents: true,
    needsInput: false,
    isolation: "none",
  } as const;
  private readonly runs = new Map<string, CursorRun>();
  private readonly agents = new Map<string, SDKAgent>();
  private readonly store: JsonlLocalAgentStore;

  constructor(
    private readonly options: {
      stateDir: string;
      workspace: string;
      apiKey?: string;
      nativeCredentials?: boolean;
      model: string;
    },
  ) {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    this.store = new JsonlLocalAgentStore(options.stateDir);
  }

  async launch(input: {
    dispatchKey: string;
    prompt: string;
    cwd: string;
  }): Promise<{ externalRunId: string; continuationHandle: string }> {
    const apiKey = this.options.apiKey ?? process.env.CURSOR_API_KEY;
    const nativeCredentials = this.options.nativeCredentials ?? true;
    if (!nativeCredentials && !apiKey)
      throw new Error(
        "Cursor isolated credential mode requires CURSOR_API_KEY or ~/.phi/credentials/cursor-api-key",
      );
    const agent = await Agent.create({
      ...(apiKey ? { apiKey } : {}),
      model: { id: this.options.model },
      local: { cwd: input.cwd, store: this.store, settingSources: [] },
    });
    const run = await agent.send(input.prompt, {
      idempotencyKey: input.dispatchKey,
    });
    const record: CursorRun = {
      agent,
      run,
      queue: new AsyncQueue(),
      cwd: input.cwd,
    };
    this.runs.set(run.id, record);
    this.agents.set(agent.agentId, agent);
    void this.pump(record);
    return { externalRunId: run.id, continuationHandle: agent.agentId };
  }

  private map(message: SDKMessage): WorkerEvent | null {
    if (message.type === "assistant") {
      const text = message.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return text
        ? { type: "activity", category: "assistant", message: text }
        : null;
    }
    if (message.type === "thinking")
      return {
        type: "activity",
        category: "reasoning",
        message: message.text || "reasoning complete",
      };
    if (message.type === "tool_call")
      return {
        type: "activity",
        nativeId: message.call_id,
        category: "tool",
        message: `${message.name}: ${message.status}`,
        data: { status: message.status },
      };
    if (message.type === "status")
      return {
        type: "activity",
        category: "status",
        message: message.message ?? message.status,
      };
    if (message.type === "usage")
      return {
        type: "activity",
        category: "usage",
        message: `tokens: ${message.usage.totalTokens}`,
        data: { ...message.usage },
      };
    if (message.type === "task")
      return {
        type: "activity",
        category: "status",
        message: message.text ?? message.status ?? "task update",
      };
    return null;
  }

  private async pump(record: CursorRun): Promise<void> {
    try {
      for await (const message of record.run.stream()) {
        const event = this.map(message);
        if (event) record.queue.push(event);
      }
      const result = await record.run.wait();
      const terminal: WorkerEvent =
        result.status === "finished"
          ? {
              type: "completed",
              nativeId: result.id,
              summary: result.result ?? "Cursor completed",
              data: { requestId: result.requestId, usage: result.usage },
            }
          : result.status === "cancelled"
            ? {
                type: "cancelled",
                nativeId: result.id,
                summary: "Cursor run cancelled",
              }
            : {
                type: "failed",
                nativeId: result.id,
                error: result.error?.message ?? "Cursor run failed",
              };
      record.terminal = terminal;
      record.queue.push(terminal);
    } catch (error) {
      const terminal: WorkerEvent = {
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
      throw new Error(`Cursor run is not attached: ${externalRunId}`);
    return record.queue;
  }

  async followUp(handle: string, text: string): Promise<void> {
    const agent = this.agents.get(handle);
    if (!agent)
      throw new UnsupportedCapabilityError(
        "Cursor follow-up requires an attached agent; resume through a new dispatch after restart",
      );
    const run = await agent.send(text);
    const record: CursorRun = { agent, run, queue: new AsyncQueue(), cwd: "" };
    this.runs.set(run.id, record);
    void this.pump(record);
  }

  async cancel(externalRunId: string): Promise<void> {
    const record = this.runs.get(externalRunId);
    if (record) await record.run.cancel();
    else
      await Agent.cancelRun(externalRunId, {
        runtime: "local",
        cwd: this.options.workspace,
        store: this.store,
      });
  }

  async reconcile(input: {
    externalRunId?: string;
  }): Promise<WorkerReconciliation> {
    if (!input.externalRunId)
      return {
        state: "unavailable",
        reason: "Cursor cannot reconcile a local launch by Phi dispatch key",
      };
    try {
      const run = await Agent.getRun(input.externalRunId, {
        runtime: "local",
        cwd: this.options.workspace,
        store: this.store,
      });
      if (run.status === "running") {
        const apiKey = this.options.apiKey ?? process.env.CURSOR_API_KEY;
        const agent = await Agent.resume(run.agentId, {
          ...(apiKey ? { apiKey } : {}),
          model: { id: this.options.model },
          local: {
            cwd: this.options.workspace,
            store: this.store,
            settingSources: [],
          },
        });
        const record: CursorRun = {
          agent,
          run,
          queue: new AsyncQueue(),
          cwd: this.options.workspace,
        };
        this.runs.set(run.id, record);
        this.agents.set(agent.agentId, agent);
        void this.pump(record);
        return {
          state: "running",
          externalRunId: run.id,
          continuationHandle: run.agentId,
        };
      }
      const result = await run.wait();
      if (result.status === "finished")
        return {
          state: "terminal",
          event: {
            type: "completed",
            nativeId: result.id,
            summary: result.result ?? "Cursor completed",
          },
        };
      if (result.status === "cancelled")
        return {
          state: "terminal",
          event: {
            type: "cancelled",
            nativeId: result.id,
            summary: "Cursor cancelled",
          },
        };
      return {
        state: "terminal",
        event: {
          type: "failed",
          nativeId: result.id,
          error: result.error?.message ?? "Cursor failed",
        },
      };
    } catch (error) {
      return {
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
