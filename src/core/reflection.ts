import type { AgentRuntime } from "@/core/agents/runtime";
import { DEFAULT_AGENT_NAME } from "@/core/agents/registry";
import type { PhiStore, ReflectionWindow } from "@/core/store/store";
import type { Message } from "@/shared/types";

export interface ReflectionOptions {
  minMessages?: number;
  messageLimit?: number;
}

export const REFLECTION_CHANNEL_NAME = "reflection";

type ReflectionDispatcher = Pick<
  AgentRuntime,
  "handleSystemMessage" | "settled"
>;

export class ReflectionService {
  private readonly minMessages: number;
  private readonly messageLimit: number;
  private running = false;

  constructor(
    private readonly store: PhiStore,
    private readonly dispatcher: ReflectionDispatcher,
    options: ReflectionOptions = {},
  ) {
    this.minMessages = options.minMessages ?? 20;
    this.messageLimit = options.messageLimit ?? 80;
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let started = 0;
    let failed = 0;
    try {
      const workspace = this.store.defaultWorkspace();
      const channels = this.store.listChannels(workspace.id);
      const reflectionChannel =
        channels.find((channel) => channel.name === REFLECTION_CHANNEL_NAME) ??
        this.store.createChannel(workspace.id, {
          name: REFLECTION_CHANNEL_NAME,
          purpose: "Audit trail for scheduled reflection runs",
        });
      for (const channel of channels) {
        if (channel.id === reflectionChannel.id) continue;
        const window = this.store.reflectionWindow(channel.id, {
          minMessages: this.minMessages,
          limit: this.messageLimit,
        });
        if (!window) continue;
        const { threadId, message } = this.createRun(
          reflectionChannel.id,
          channel.id,
          channel.name,
          window,
        );
        this.dispatcher.handleSystemMessage(message, [DEFAULT_AGENT_NAME]);
        await this.dispatcher.settled(threadId);
        // Advance only after the agent produced a durable reply. A crash,
        // cancellation, or system error leaves the window eligible for retry;
        // reflection threads themselves are excluded from future input.
        if (this.store.lastAgentMessage(threadId)) {
          this.store.recordReflectionRun(channel.id, window.throughSeq, threadId);
        } else {
          failed += 1;
        }
        started += 1;
      }
      if (failed > 0) {
        throw new Error(
          `${failed} reflection ${failed === 1 ? "run" : "runs"} ended without an agent reply`,
        );
      }
      return started;
    } finally {
      this.running = false;
    }
  }

  private createRun(
    reflectionChannelId: string,
    sourceChannelId: string,
    sourceChannelName: string,
    window: ReflectionWindow,
  ): { threadId: string; message: Message } {
    const result = this.store.createThread(reflectionChannelId, {
      author: "system",
      kind: "reflection",
      content: reflectionPrompt(sourceChannelName, window),
      metadata: {
        reflection: true,
        sourceChannelId,
        sourceChannelName,
        fromSeq: window.fromSeq,
        throughSeq: window.throughSeq,
        routedTo: [DEFAULT_AGENT_NAME],
      },
    });
    return { threadId: result.thread.id, message: result.message };
  }
}

export function reflectionPrompt(
  channelName: string,
  window: ReflectionWindow,
): string {
  return `Run the scheduled reflection pass for #${channelName} over the frozen ${window.messageCount}-message window ${window.fromSeq}–${window.throughSeq}.

The messages are not embedded here. Start with list_channel_threads on #${channelName} with from_seq ${window.fromSeq} and through_seq ${window.throughSeq}, then use read_thread on the threads that carry durable facts, decisions, corrections, outcomes, or repeated failures. Base your changes only on evidence inside this window — later messages will be covered by the next pass. Do not infer from previews alone; read the relevant thread before changing memory or proposing a procedure.

Use two output lanes:

1. Fact lane — apply only durable, explicit facts, decisions, corrections, and user-stated preferences. Before writing, inspect .agents/memories/MEMORY.md and the relevant fact files. Update or supersede the canonical one-fact Markdown file instead of adding a duplicate, keep MEMORY.md indexed, and remove stale index entries. Delete an agent-authored fact file only when a replacement fully subsumes it and preserves its provenance; never delete or rewrite user-authored memory. Mark uncertain conflicts for review instead of silently choosing. Put workspace-wide user rules/preferences in rules.md and channel-specific ones in channels/${channelName}/rules.md. Use schema_version 1 and record type, scope, learned_at, and source thread. Never edit AGENTS.md.
2. Instruction lane — do not directly change skills or inferred procedural rules. When repeated failures, user corrections, or outcome tags justify a procedure change, open a review thread with create_thread. Begin every proposal thread with the exact hidden marker \`<!-- phi:reflection-proposal -->\` so later reflection passes exclude it. Route channel-scoped proposals to #${channelName} and target channels/${channelName}/skills/ or rules.md. Route workspace-global proposals to #meta and target .agents/skills/; if #meta does not exist, file the proposal here and label it workspace-global. Propose small delta edits with provenance and verification criteria, never a full rewrite.

Preserve user-authored wording and make no change when the evidence is weak. Summarize the threads inspected, applied fact changes or cleanup, and links to any review threads in your reply.`;
}
