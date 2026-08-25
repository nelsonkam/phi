import {
  Codex,
  type ModelReasoningEffort,
  type Thread,
  type ThreadEvent,
} from "@openai/codex-sdk";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { workerEfforts, type WorkerEffort } from "../domain.ts";
import { UnsupportedCapabilityError } from "../errors.ts";
import type {
  WorkerAdapter,
  WorkerEvent,
  WorkerModelCatalog,
  WorkerReconciliation,
  WorkerStatus,
} from "./adapter.ts";
import {
  awaitStartId,
  createLiveRun,
  LiveRunTable,
  type LiveRun,
} from "./live-run.ts";

interface CodexRun extends LiveRun {
  thread: Thread;
  controller: AbortController;
  lastAssistant?: string;
}

export function codexCompletionEvent(
  lastAssistant: string | undefined,
  usage: unknown,
): Extract<WorkerEvent, { type: "completed" }> {
  return {
    type: "completed",
    nativeId: "turn.completed",
    summary: lastAssistant?.trim() || "Codex turn completed",
    data: { usage },
  };
}

export class CodexWorkerAdapter implements WorkerAdapter {
  readonly id = "codex";
  readonly capabilities = {
    continuation: "sequential",
    cancellation: "abort",
  } as const;
  private readonly runs = new LiveRunTable<CodexRun>("Codex thread");
  private readonly codex: Codex;

  constructor(
    private readonly options: {
      codexHome?: string;
      apiKey?: string;
      model?: string;
      models?: string[];
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

  async status(): Promise<WorkerStatus> {
    if (this.options.apiKey || process.env.OPENAI_API_KEY)
      return {
        readiness: "unverified",
        detail: "OpenAI API key configured",
        interactiveAuth: false,
      };
    const codexHome =
      this.options.codexHome ??
      process.env.CODEX_HOME ??
      join(homedir(), ".codex");
    if (existsSync(join(codexHome, "auth.json")))
      return {
        readiness: "ready",
        detail: `Codex login found under ${codexHome}`,
        interactiveAuth: false,
      };
    return {
      readiness: "unverified",
      detail: "Codex OS credential-store login is checked when a job launches",
      interactiveAuth: false,
    };
  }

  async modelCatalog(): Promise<WorkerModelCatalog> {
    const ids = new Set([
      ...(this.options.models ?? []),
      ...(this.options.model ? [this.options.model] : []),
    ]);
    return {
      defaultModel: this.options.model ?? null,
      models: [...ids].map((id) => ({
        id,
        label: id,
        effortLevels: [...workerEfforts],
      })),
      defaultEffortLevels: [...workerEfforts],
      note: ids.size
        ? "Selectable models come from PHI_CODEX_MODELS."
        : "The Codex SDK exposes model selection but not catalog discovery; set PHI_CODEX_MODELS to enable explicit choices.",
    };
  }

  async launch(input: {
    prompt: string;
    cwd: string;
    mode: "read_only" | "mutating";
    model?: string;
    effort?: WorkerEffort;
  }): Promise<{ externalRunId: string; continuationHandle: string }> {
    const thread = this.codex.startThread({
      workingDirectory: input.cwd,
      skipGitRepoCheck: false,
      sandboxMode: input.mode === "read_only" ? "read-only" : "workspace-write",
      approvalPolicy: "never",
      ...((input.model ?? this.options.model)
        ? { model: input.model ?? this.options.model }
        : {}),
      ...(input.effort
        ? { modelReasoningEffort: input.effort as ModelReasoningEffort }
        : {}),
    });
    const record: CodexRun = {
      ...createLiveRun(),
      thread,
      controller: new AbortController(),
    };
    const started = Promise.withResolvers<string>();
    void this.pump(record, input.prompt, started);
    const threadId = await awaitStartId(
      started.promise,
      "Codex SDK did not emit a thread id",
    );
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
    if (event.type === "turn.completed") return null;
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
    let error: unknown;
    try {
      const streamed = await record.thread.runStreamed(prompt, {
        signal: record.controller.signal,
      });
      for await (const sdkEvent of streamed.events) {
        if (sdkEvent.type === "thread.started")
          started.resolve(sdkEvent.thread_id);
        const event =
          sdkEvent.type === "turn.completed"
            ? codexCompletionEvent(record.lastAssistant, sdkEvent.usage)
            : this.map(sdkEvent);
        if (!event) continue;
        if (event.type === "activity" && event.category === "assistant")
          record.lastAssistant = event.message;
        this.runs.emit(record, event);
      }
    } catch (caught) {
      started.reject(caught);
      error = caught;
    } finally {
      this.runs.finishStream(
        record,
        record.controller.signal.aborted,
        {
          cancelled: "Codex turn aborted",
          failed: "Codex stream ended without a terminal event",
        },
        error,
      );
    }
  }

  watch(externalRunId: string): AsyncIterable<WorkerEvent> {
    return this.runs.watch(externalRunId);
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
  async reconcile(_input?: {
    dispatchKey: string;
    externalRunId?: string;
    model?: string;
    effort?: WorkerEffort;
  }): Promise<WorkerReconciliation> {
    return {
      state: "unavailable",
      reason:
        "Codex SDK can resume a thread for a new turn but cannot authoritatively inspect an interrupted turn by dispatch key",
    };
  }
}
