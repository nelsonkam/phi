import { readFileSync, statSync } from "node:fs";
import type { PhiStore } from "../db/store.ts";
import type { JobMode, MessageKind } from "../domain.ts";
import { dispatchKey, messageKey } from "../ids.ts";
import type { CancellationService } from "../jobs/cancellation.ts";
import type { FollowUpDispatcher } from "../jobs/followups.ts";
import type { JobScheduler } from "../jobs/scheduler.ts";
import type { OutboxDispatcher } from "../messaging/dispatcher.ts";
import { confinedWorkspacePath } from "../paths.ts";
import { Type } from "typebox";
import type { TurnContext } from "./turn-context.ts";

export class CoordinatorTools {
  constructor(
    private readonly options: {
      store: PhiStore;
      workspaceId: string;
      workspace: string;
      turn: TurnContext;
      scheduler: JobScheduler;
      followUps: FollowUpDispatcher;
      cancellation: CancellationService;
      outbox: OutboxDispatcher;
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
    const result = this.options.store.putOutbox({
      eventId: event.id,
      kind,
      content,
      metadata,
      idempotencyKey: messageKey(event, kind),
    });
    this.options.outbox.wake();
    return result;
  }

  dispatch(key: string, adapter: string, prompt: string, mode: JobMode) {
    const event = this.options.turn.require();
    const result = this.options.store.acceptJob({
      workspaceId: this.options.workspaceId,
      sourceEventId: event.id,
      adapter,
      key: dispatchKey(event.id, key),
      prompt,
      mode,
    });
    this.options.scheduler.wake();
    return result;
  }

  inspect(jobId: string) {
    return this.options.store.getJob(jobId);
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
      sourceEventId: event.id,
      key: `followup:${event.id}:${jobId}`,
      content,
    });
    this.options.followUps.wake();
    return result;
  }

  async cancel(jobId: string) {
    const event = this.options.turn.require();
    return this.options.cancellation.request({
      jobId,
      sourceEventId: event.id,
      key: `cancel:${event.id}:${jobId}`,
    });
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
            Type.Literal("progress"),
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
        name: "dispatch_job",
        label: "Dispatch job",
        description:
          "Durably accept concurrent worker work. Mode is advisory and never a lease.",
        parameters: Type.Object({
          key: Type.String(),
          adapter: Type.String(),
          prompt: Type.String(),
          mode: Type.Union([
            Type.Literal("read_only"),
            Type.Literal("mutating"),
          ]),
        }),
        execute: async (
          _id: string,
          params: {
            key: string;
            adapter: string;
            prompt: string;
            mode: JobMode;
          },
        ) =>
          text(
            this.dispatch(
              params.key,
              params.adapter,
              params.prompt,
              params.mode,
            ),
          ),
      },
      {
        name: "inspect_job",
        label: "Inspect job",
        description: "Read durable job state.",
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
