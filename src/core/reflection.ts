import type { AgentRuntime } from "@/core/agents/runtime";
import { DEFAULT_AGENT_NAME } from "@/core/agents/registry";
import type { PhiStore } from "@/core/store/store";

export const REFLECTION_CHANNEL_NAME = "reflection";

export const REFLECTION_PROMPT =
  "Run the reflect skill. Read `.agents/skills/reflect/SKILL.md` and follow it.";

type ReflectionDispatcher = Pick<
  AgentRuntime,
  "handleSystemMessage" | "settled"
>;

export class ReflectionService {
  private running = false;

  constructor(
    private readonly store: PhiStore,
    private readonly dispatcher: ReflectionDispatcher,
  ) {}

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const workspace = this.store.defaultWorkspace();
      const reflectionChannel =
        this.store
          .listChannels(workspace.id)
          .find((channel) => channel.name === REFLECTION_CHANNEL_NAME) ??
        this.store.createChannel(workspace.id, {
          name: REFLECTION_CHANNEL_NAME,
          purpose: "Audit trail for scheduled reflection runs",
        });
      const { thread, message } = this.store.createThread(reflectionChannel.id, {
        author: "system",
        kind: "reflection",
        content: REFLECTION_PROMPT,
        metadata: {
          reflection: true,
          routedTo: [DEFAULT_AGENT_NAME],
        },
      });
      this.dispatcher.handleSystemMessage(message, [DEFAULT_AGENT_NAME]);
      await this.dispatcher.settled(thread.id);
      if (!this.store.lastAgentMessage(thread.id)) {
        throw new Error("reflection run ended without an agent reply");
      }
      return 1;
    } finally {
      this.running = false;
    }
  }
}
