import { PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { connectAcpProcess } from "./acp-process";
import type { AcpProcess } from "./acp-process";
import { harnessEntry } from "./harnesses";
import { loadDefaultAgent } from "./registry";
import type { AgentDefinition } from "./registry";
import type { PhiStore } from "@/core/store/store";
import type { Message } from "@/shared/types";

const HANDSHAKE_TIMEOUT_MS = 30_000;
// JSON-RPC error code ACP agents use for `auth_required`.
const AUTH_REQUIRED_CODE = -32000;

// One live harness session bound to one thread (see
// docs/channels-and-server.md §5). Sessions are in-memory only for now: a
// server restart starts fresh sessions on the next message.
interface ThreadSession {
  acp: AcpProcess;
  sessionId: string;
  agentName: string;
  // ACP may emit multiple logical agent messages during one turn (for example,
  // commentary followed by a final answer). Chunks within a message are deltas
  // and concatenate exactly; distinct messages retain a paragraph boundary.
  turnText: Array<{ messageId: string | undefined; chunks: string[] }>;
}

export interface AgentRuntimeOptions {
  // Test hook: resolves the ACP launch command for a harness id. Defaults to
  // the harness catalog.
  resolveCommand?: (harnessId: string) => string[] | null;
}

// Routes stored user messages to agent sessions and writes replies back
// through the store, which broadcasts them like any other message. The
// server calls handleUserMessage after each user-message commit.
export class AgentRuntime {
  private readonly store: PhiStore;
  private readonly workspaceRoot: string;
  private readonly resolveCommand: (harnessId: string) => string[] | null;
  private readonly sessions = new Map<string, ThreadSession>();
  // Per-thread promise chain; one turn runs at a time per thread and
  // messages posted mid-turn become the next turn.
  private readonly turns = new Map<string, Promise<void>>();

  constructor(
    store: PhiStore,
    workspaceRoot: string,
    options: AgentRuntimeOptions = {},
  ) {
    this.store = store;
    this.workspaceRoot = workspaceRoot;
    this.resolveCommand =
      options.resolveCommand ??
      ((harnessId) => harnessEntry(harnessId)?.acpCommand?.() ?? null);
  }

  handleUserMessage(message: Message): void {
    if (message.author !== "user") return;
    const prev = this.turns.get(message.threadId) ?? Promise.resolve();
    // runTurn reports every failure as a message, so the chain never rejects.
    this.turns.set(
      message.threadId,
      prev.then(() => this.runTurn(message)),
    );
  }

  // Resolves when every turn queued for the thread so far has finished.
  settled(threadId: string): Promise<void> {
    return this.turns.get(threadId) ?? Promise.resolve();
  }

  // Sessions are in-memory, so a restart silently drops any turn that was in
  // flight — leaving the thread ending on a user message with no reply ever
  // coming. Called once at server startup: report the interruption so clients
  // don't render a permanent "agent is working" state.
  recoverInterruptedTurns(): void {
    const workspace = this.store.defaultWorkspace();
    for (const channel of this.store.listChannels(workspace.id)) {
      for (const thread of this.store.listThreads(channel.id)) {
        if (thread.status === "archived") continue;
        const last = this.store.listMessages(thread.id).at(-1);
        if (last?.author !== "user") continue;
        this.store.appendMessage(thread.id, {
          author: "system",
          kind: "error",
          content:
            "The server restarted before the agent replied. Send another message to retry.",
        });
      }
    }
  }

  close(): void {
    for (const threadId of [...this.sessions.keys()]) {
      this.dropSession(threadId);
    }
  }

  private async runTurn(userMessage: Message): Promise<void> {
    const threadId = userMessage.threadId;
    try {
      const session = await this.ensureSession(threadId);
      session.turnText = [];
      const response = (await session.acp.connection.agent.request(
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: userMessage.content }],
        },
      )) as PromptResponse;

      const text = session.turnText
        .map(({ chunks }) => chunks.join("").trim())
        .filter((message) => message.length > 0)
        .join("\n\n")
        .trim();
      if (text.length > 0) {
        this.store.appendMessage(threadId, {
          author: "coordinator",
          kind: "message",
          content: text,
          metadata: {
            agent: session.agentName,
            stopReason: response.stopReason,
          },
        });
      } else {
        this.store.appendMessage(threadId, {
          author: "system",
          kind: "error",
          content: `${session.agentName} ended the turn without a reply (${response.stopReason})`,
        });
      }
    } catch (error) {
      // The session may be mid-broken (dead process, protocol error); drop it
      // so the next message starts clean.
      this.dropSession(threadId);
      this.store.appendMessage(threadId, {
        author: "system",
        kind: "error",
        content: (error as Error).message,
      });
    }
  }

  private async ensureSession(threadId: string): Promise<ThreadSession> {
    const existing = this.sessions.get(threadId);
    if (existing && existing.acp.proc.exitCode === null) return existing;
    if (existing) this.dropSession(threadId);

    const agent = await loadDefaultAgent(this.workspaceRoot);
    if (!agent) {
      throw new Error("no default agent is configured; finish setup first");
    }
    const command = this.resolveCommand(agent.harness);
    if (!command) {
      throw new Error(
        `agent "${agent.name}": harness "${agent.harness}" cannot be launched over ACP`,
      );
    }

    const session: ThreadSession = {
      acp: null as unknown as AcpProcess,
      sessionId: "",
      agentName: agent.name,
      turnText: [],
    };
    session.acp = connectAcpProcess(command, this.workspaceRoot, {
      onSessionUpdate: (notification) => {
        if (notification.sessionId !== session.sessionId) return;
        const update = notification.update;
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text"
        ) {
          const messageId = update.messageId ?? undefined;
          const current = session.turnText.at(-1);
          if (
            !current ||
            (messageId !== undefined && current.messageId !== messageId)
          ) {
            session.turnText.push({ messageId, chunks: [update.content.text] });
          } else {
            current.chunks.push(update.content.text);
          }
        }
      },
      onRequestPermission: approvePermission,
    });
    const { proc, connection } = session.acp;

    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `session setup timed out after ${HANDSHAKE_TIMEOUT_MS / 1000}s`,
          ),
        ),
      HANDSHAKE_TIMEOUT_MS,
    );
    // Fail fast if the agent binary dies before the session exists.
    const exited = proc.exited.then(() => {
      throw new Error(`${agent.harness} exited during session setup`);
    });

    try {
      await connection.agent.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
          },
        },
        { cancellationSignal: controller.signal },
      );
      const created = (await Promise.race([
        connection.agent.request(
          "session/new",
          { cwd: this.workspaceRoot, mcpServers: [] },
          { cancellationSignal: controller.signal },
        ),
        exited,
      ])) as NewSessionResponse;
      session.sessionId = created.sessionId;

      await this.applyAgentConfig(session, agent, created);
      this.sessions.set(threadId, session);
      return session;
    } catch (error) {
      connection.close();
      proc.kill();
      if (error instanceof RequestError && error.code === AUTH_REQUIRED_CODE) {
        const entry = harnessEntry(agent.harness);
        const hint = entry ? ` — run \`${entry.loginHint}\`` : "";
        throw new Error(
          `${agent.harness} is not logged in on this machine${hint}`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // Applies the agent's saved model and config choices to a fresh session.
  // Failures degrade to harness defaults rather than blocking the turn.
  private async applyAgentConfig(
    session: ThreadSession,
    agent: AgentDefinition,
    created: NewSessionResponse,
  ): Promise<void> {
    const values = new Map<string, string | boolean>(
      Object.entries(agent.config),
    );
    // The model lives on the agent, not in config; map it onto the config
    // option the harness advertises in the "model" category.
    if (agent.model) {
      const modelOption = (created.configOptions ?? []).find(
        (option) => option.category === "model",
      );
      if (modelOption) values.set(modelOption.id, agent.model);
    }

    for (const [configId, value] of values) {
      const params =
        typeof value === "boolean"
          ? {
              sessionId: session.sessionId,
              configId,
              type: "boolean" as const,
              value,
            }
          : { sessionId: session.sessionId, configId, value };
      await session.acp.connection.agent
        .request("session/set_config_option", params)
        .catch((error: Error) => {
          console.warn(
            `agent "${session.agentName}": config option "${configId}" was not applied: ${error.message}`,
          );
        });
    }
  }

  private dropSession(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.sessions.delete(threadId);
    session.acp.connection.close();
    session.acp.proc.kill();
  }
}

// Agents run unattended against phi's own workspace, so tool calls are
// approved. Per-call approval is preferred over "always" grants so a future
// permission UI can slot in without unlearning blanket grants.
function approvePermission(
  request: RequestPermissionRequest,
): RequestPermissionResponse {
  for (const kind of ["allow_once", "allow_always"] as const) {
    const option = request.options.find((o) => o.kind === kind);
    if (option) {
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}
