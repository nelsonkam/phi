import { readFileSync, statSync } from "node:fs";
import { Type } from "typebox";
import type { PhiStore } from "../db/store.ts";
import {
  workerEfforts,
  type JobMode,
  type MessageKind,
  type MessageRecord,
  type WorkerEffort,
} from "../domain.ts";
import { dispatchKey, messageKey } from "../ids.ts";
import type { FollowUpDispatcher } from "../jobs/followups.ts";
import type { JobScheduler } from "../jobs/scheduler.ts";
import { confinedWorkspacePath } from "../paths.ts";
import type { WorkerAdapterRegistry } from "../workers/adapter.ts";
import type { TurnContext } from "./turn-context.ts";

const workerEffortType = Type.Union([
  Type.Literal(workerEfforts[0]),
  Type.Literal(workerEfforts[1]),
  Type.Literal(workerEfforts[2]),
  Type.Literal(workerEfforts[3]),
  Type.Literal(workerEfforts[4]),
  Type.Literal(workerEfforts[5]),
  Type.Literal(workerEfforts[6]),
]);

export class CoordinatorTools {
  constructor(
    private readonly options: {
      store: PhiStore;
      workspace: string;
      turn: TurnContext;
      scheduler: JobScheduler;
      followUps: FollowUpDispatcher;
      adapters: WorkerAdapterRegistry;
      onMessage?: (message: MessageRecord) => void;
    },
  ) {}

  sendMessage(
    kind: MessageKind,
    content: string,
    metadata: Record<string, unknown> = {},
  ) {
    const event = this.options.turn.require();
    if (event.kind === "worker_needs_input" && kind !== "question")
      throw new Error("worker needs-input events require a question message");
    if (
      ["worker_completed", "worker_failed", "worker_cancelled"].includes(
        event.kind,
      ) &&
      kind !== "result"
    )
      throw new Error("worker terminal events require a result message");
    const result = this.options.store.putMessage({
      eventId: event.id,
      kind,
      content,
      metadata,
      idempotencyKey: messageKey(event),
    });
    if (result.created) this.options.onMessage?.(result.message);
    return result;
  }

  async dispatch(
    key: string,
    adapter: string,
    prompt: string,
    mode: JobMode,
    selection: { model?: string; effort?: WorkerEffort } = {},
  ) {
    const event = this.options.turn.require();
    const resolved = await this.options.adapters.resolveSelection(
      adapter,
      selection,
    );
    const result = this.options.store.acceptJob({
      adapter,
      key: dispatchKey(event.id, key),
      prompt,
      mode,
      ...resolved,
    });
    this.options.scheduler.wake();
    return result;
  }

  listWorkers() {
    return this.options.adapters.describeAll();
  }

  async catalogSummary(): Promise<string> {
    return (await this.options.adapters.describeAll())
      .map((adapter) =>
        JSON.stringify({
          id: adapter.id,
          readiness: adapter.readiness,
          capabilities: adapter.capabilities,
          modelCatalog: adapter.modelCatalog,
        }),
      )
      .join("; ");
  }

  inspect(jobId: string) {
    const job = this.options.store.getJob(jobId);
    const observations = this.options.store.listJobEvents(jobId);
    const recentObservations = observations.slice(-12).map((event) => ({
      kind: event.kind,
      payload: event.payload,
      createdAt: event.createdAt,
    }));
    const lastActivityAt =
      observations.at(-1)?.createdAt ?? job.updatedAt ?? job.createdAt;
    const adapter = this.options.adapters.get(job.adapter);
    return {
      job,
      lastActivityAt,
      staleForMs: Math.max(0, Date.now() - Date.parse(lastActivityAt)),
      recentObservations,
      availableActions: {
        followUp: job.status === "needs_input" && adapter.capabilities.followUp,
        cancel:
          ["launching", "running", "needs_input", "cancelling"].includes(
            job.status,
          ) && adapter.capabilities.cancel,
      },
    };
  }

  readWorkspace(path: string): {
    path: string;
    content: string;
    truncated: boolean;
  } {
    const target = confinedWorkspacePath(this.options.workspace, path);
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error("read_workspace accepts files only");
    const content = readFileSync(target, "utf8");
    return {
      path,
      content: content.slice(0, 128_000),
      truncated: content.length > 128_000,
    };
  }

  followUp(jobId: string, content: string) {
    const event = this.options.turn.require();
    const result = this.options.store.enqueueFollowUp({
      jobId,
      key: `followup:${event.id}:${jobId}`,
      content,
    });
    this.options.followUps.wake();
    return result;
  }

  async cancel(jobId: string) {
    const event = this.options.turn.require();
    const job = this.options.store.requestCancellation({
      jobId,
      key: `cancel:${event.id}:${jobId}`,
    });
    if (job.status !== "cancelling" || !job.externalRunId) return job;
    try {
      await this.options.adapters.get(job.adapter).cancel(job.externalRunId);
    } catch (error) {
      return this.options.store.markUnknown(
        job.id,
        `cancellation outcome unknown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.options.store.getJob(job.id);
  }

  definitions() {
    const text = (value: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      details: value,
    });
    return [
      {
        name: "send_message",
        label: "Send message",
        description: "Create the only authoritative user-visible Phi message.",
        parameters: Type.Object({
          kind: Type.Union([
            Type.Literal("ack"),
            Type.Literal("result"),
            Type.Literal("question"),
          ]),
          content: Type.String(),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        execute: async (
          _id: string,
          params: {
            kind: MessageKind;
            content: string;
            metadata?: Record<string, unknown>;
          },
        ) =>
          text(this.sendMessage(params.kind, params.content, params.metadata)),
      },
      {
        name: "list_workers",
        label: "List workers",
        description:
          "List registered worker harnesses, authentication readiness, and capability boundaries. Call this before choosing a worker.",
        parameters: Type.Object({}),
        execute: async () => text(await this.listWorkers()),
      },
      {
        name: "dispatch_job",
        label: "Dispatch job",
        description:
          "Durably accept concurrent worker work with a host-validated root model. Mode is advisory and never a lease.",
        parameters: Type.Object({
          key: Type.String(),
          adapter: Type.String(),
          prompt: Type.String(),
          mode: Type.Union([
            Type.Literal("read_only"),
            Type.Literal("mutating"),
          ]),
          model: Type.Optional(Type.String()),
          effort: Type.Optional(workerEffortType),
        }),
        execute: async (
          _id: string,
          params: {
            key: string;
            adapter: string;
            prompt: string;
            mode: JobMode;
            model?: string;
            effort?: WorkerEffort;
          },
        ) =>
          text(
            await this.dispatch(
              params.key,
              params.adapter,
              params.prompt,
              params.mode,
              {
                ...(params.model ? { model: params.model } : {}),
                ...(params.effort ? { effort: params.effort } : {}),
              },
            ),
          ),
      },
      {
        name: "inspect_job",
        label: "Inspect job",
        description:
          "Read durable job state, selected model, recent observations, last activity, staleness, and available actions.",
        parameters: Type.Object({ jobId: Type.String() }),
        execute: async (_id: string, params: { jobId: string }) =>
          text(this.inspect(params.jobId)),
      },
      {
        name: "read_workspace",
        label: "Read workspace",
        description:
          "Read one confined workspace file without shell or write access.",
        parameters: Type.Object({ path: Type.String() }),
        execute: async (_id: string, params: { path: string }) =>
          text(this.readWorkspace(params.path)),
      },
      {
        name: "follow_up_job",
        label: "Follow up job",
        description: "Persist continuation input for a job in needs_input.",
        parameters: Type.Object({
          jobId: Type.String(),
          content: Type.String(),
        }),
        execute: async (
          _id: string,
          params: { jobId: string; content: string },
        ) => text(this.followUp(params.jobId, params.content)),
      },
      {
        name: "cancel_job",
        label: "Cancel job",
        description:
          "Persist cancellation intent before asking the adapter to cancel.",
        parameters: Type.Object({ jobId: Type.String() }),
        execute: async (_id: string, params: { jobId: string }) =>
          text(await this.cancel(params.jobId)),
      },
    ];
  }
}
