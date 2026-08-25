import {
  Agent,
  Cursor,
  JsonlLocalAgentStore,
  type Run,
  type SDKAgent,
  type SDKMessage,
} from "@cursor/sdk/bundled";
import { mkdirSync } from "node:fs";
import type { WorkerEffort } from "../domain.ts";
import {
  buildModelCatalog,
  type WorkerAdapter,
  type WorkerEvent,
  type WorkerModelCatalog,
  type WorkerReconciliation,
  type WorkerStatus,
} from "./adapter.ts";
import { createLiveRun, LiveRunTable, type LiveRun } from "./live-run.ts";

interface CursorRun extends LiveRun {
  agent: SDKAgent;
  run: Run;
  cwd: string;
}

export class CursorWorkerAdapter implements WorkerAdapter {
  readonly id = "cursor";
  readonly capabilities = {
    followUp: true,
    cancel: true,
  } as const;
  private readonly runs = new LiveRunTable<CursorRun>("Cursor run");
  private readonly agents = new Map<string, SDKAgent>();
  private readonly store: JsonlLocalAgentStore;
  private sessionApiKey?: string;

  constructor(
    private readonly options: {
      stateDir: string;
      workspace: string;
      apiKey?: string;
      nativeCredentials?: boolean;
      model: string;
      models?: string[];
    },
  ) {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    this.store = new JsonlLocalAgentStore(options.stateDir);
  }

  async status(): Promise<WorkerStatus> {
    const interactiveAuth = this.options.nativeCredentials ?? true;
    if (this.sessionApiKey || this.options.apiKey)
      return {
        readiness: "ready",
        detail: "explicit Cursor SDK credential configured",
        interactiveAuth,
      };
    if (process.env.CURSOR_API_KEY)
      return {
        readiness: "unverified",
        detail:
          "CURSOR_API_KEY is set and takes precedence over stored SDK login",
        interactiveAuth,
      };
    if (this.options.nativeCredentials ?? true) {
      const status = await Cursor.auth.status();
      if (status.status === "logged-in")
        return {
          readiness: "ready",
          detail: status.email
            ? `Cursor SDK login: ${status.email}`
            : "Cursor SDK browser login",
          interactiveAuth,
        };
    }
    return {
      readiness: "login_required",
      detail: "Cursor SDK browser login required",
      interactiveAuth,
    };
  }

  async modelCatalog(): Promise<WorkerModelCatalog> {
    const labels: Record<string, string> = {
      "grok-4.6": "Cursor Grok 4.6",
      "grok-4.5": "Cursor Grok 4.5",
      "composer-2.5": "Composer 2.5",
      "composer-2": "Composer 2",
    };
    return buildModelCatalog({
      defaultModel: this.options.model,
      ids: [this.options.model, ...(this.options.models ?? [])],
      effortLevels: [],
      label: (id) => labels[id] ?? id,
      note: "Phi intentionally restricts Cursor to the SDK-validated Grok and Composer model families.",
    });
  }

  async authenticate(options?: {
    onLoginUrl?: (url: string) => void;
    signal?: AbortSignal;
  }): Promise<WorkerStatus> {
    if (!(this.options.nativeCredentials ?? true))
      throw new Error(
        "Cursor SDK browser login is disabled in isolated credential mode",
      );
    const result = await Cursor.auth.login({
      apiKeyName: "Phi harness",
      ...(options?.onLoginUrl ? { onLoginUrl: options.onLoginUrl } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    this.sessionApiKey = result.apiKey;
    return {
      readiness: "ready",
      detail: result.email
        ? `Cursor SDK login: ${result.email}`
        : "Cursor SDK browser login complete",
      interactiveAuth: true,
    };
  }

  async launch(input: {
    dispatchKey: string;
    prompt: string;
    cwd: string;
    model?: string;
    effort?: WorkerEffort;
  }): Promise<{ externalRunId: string; continuationHandle: string }> {
    const apiKey =
      this.sessionApiKey ?? this.options.apiKey ?? process.env.CURSOR_API_KEY;
    const nativeCredentials = this.options.nativeCredentials ?? true;
    if (!nativeCredentials && !apiKey)
      throw new Error(
        "Cursor isolated credential mode requires CURSOR_API_KEY or ~/.phi/credentials/cursor-api-key",
      );
    const agent = await Agent.create({
      ...(apiKey ? { apiKey } : {}),
      model: { id: input.model ?? this.options.model },
      local: { cwd: input.cwd, store: this.store, settingSources: [] },
    });
    const run = await agent.send(input.prompt, {
      idempotencyKey: input.dispatchKey,
    });
    const record: CursorRun = {
      ...createLiveRun(),
      agent,
      run,
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
    let error: unknown;
    try {
      for await (const message of record.run.stream()) {
        const event = this.map(message);
        if (event) this.runs.emit(record, event);
      }
      const result = await record.run.wait();
      this.runs.emit(
        record,
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
              },
      );
    } catch (caught) {
      error = caught;
    } finally {
      this.runs.finishStream(
        record,
        false,
        {
          cancelled: "Cursor run cancelled",
          failed: "Cursor stream ended without a terminal event",
        },
        error,
      );
    }
  }

  watch(externalRunId: string): AsyncIterable<WorkerEvent> {
    return this.runs.watch(externalRunId);
  }

  async followUp(handle: string, text: string): Promise<void> {
    const agent = this.agents.get(handle);
    if (!agent)
      throw new Error(
        "Cursor follow-up requires an attached agent; resume through a new dispatch after restart",
      );
    const run = await agent.send(text);
    const record: CursorRun = { ...createLiveRun(), agent, run, cwd: "" };
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
    model?: string;
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
        const apiKey =
          this.sessionApiKey ??
          this.options.apiKey ??
          process.env.CURSOR_API_KEY;
        const agent = await Agent.resume(run.agentId, {
          ...(apiKey ? { apiKey } : {}),
          model: { id: input.model ?? this.options.model },
          local: {
            cwd: this.options.workspace,
            store: this.store,
            settingSources: [],
          },
        });
        const record: CursorRun = {
          ...createLiveRun(),
          agent,
          run,
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
