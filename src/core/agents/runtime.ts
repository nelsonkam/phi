import { PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { connectAcpProcess } from "./acp-process";
import type { AcpProcess } from "./acp-process";
import { harnessEntry } from "./harnesses";
import { DEFAULT_AGENT_NAME, loadDefaultAgent } from "./registry";
import type { AgentDefinition } from "./registry";
import type { PhiStore } from "@/core/store/store";
import type { ThreadSessionBinding } from "@/core/store/store";
import type { Message } from "@/shared/types";

const HANDSHAKE_TIMEOUT_MS = 30_000;
// JSON-RPC error code ACP agents use for `auth_required`.
const AUTH_REQUIRED_CODE = -32000;
// Sent on the first prompt of each fresh harness session only: later turns
// (and resumed sessions) already carry it in the harness's own history, and
// the phi MCP server repeats the same guidance in send_message's tool
// description and server instructions, so the model sees it every turn
// regardless.
export const MESSAGING_PREAMBLE = `Use phi's send_message tool for every user-visible message; text outside that tool is private and will normally be discarded. Your first action must be send_message: answer immediately when the request is quick, or briefly acknowledge it and name the first concrete step. For multi-step work, send concise updates at meaningful beats. An acknowledgement is not the result, so send the actual answer or outcome before ending the turn, then close substantial work with a short recap.`;

const RECOVERY_CONTEXT_MAX_CHARS = 16_000;

type SessionAgent = Pick<
  AgentDefinition,
  "name" | "harness" | "model" | "config"
>;

// One live harness process bound to one thread (see
// docs/channels-and-server.md §5). The live process is an in-memory cache; the
// harness session id is durable in PhiStore and can be resumed after restart.
interface ThreadSession {
  acp: AcpProcess;
  sessionId: string;
  agentName: string;
  mcpToken: string;
  closeSupported: boolean;
  // False until the messaging preamble has reached the harness session, either
  // by this process sending it or by resuming a session whose history has it.
  primed: boolean;
  recoveryContext?: string;
  // ACP may emit multiple logical agent messages during one turn (for example,
  // commentary followed by a final answer). Chunks within a message are deltas
  // and concatenate exactly; distinct messages retain a paragraph boundary.
  turnText: Array<{ messageId: string | undefined; chunks: string[] }>;
}

export interface AgentRuntimeOptions {
  // Test hook: resolves the ACP launch command for a harness id. Defaults to
  // the harness catalog.
  resolveCommand?: (harnessId: string) => string[] | null;
  mcpPort: number;
  mcpTokens: {
    mint(caller: { threadId: string; agentName: string }): string;
    revoke(token: string): void;
    beginTurn(token: string): void;
    sendCount(token: string): number;
  };
}

// Routes stored user messages to agent sessions and writes replies back
// through the store, which broadcasts them like any other message. The
// server calls handleUserMessage after each user-message commit.
export class AgentRuntime {
  private readonly store: PhiStore;
  private readonly workspaceRoot: string;
  private readonly resolveCommand: (harnessId: string) => string[] | null;
  private readonly mcpPort: number;
  private readonly mcpTokens: AgentRuntimeOptions["mcpTokens"];
  private readonly sessions = new Map<string, ThreadSession>();
  // Per-thread promise chain; one turn runs at a time per thread and
  // messages posted mid-turn become the next turn.
  private readonly turns = new Map<string, Promise<void>>();
  // Turns queued or running per thread. The working flag flips on when the
  // count leaves zero and off when it returns, so clients see one continuous
  // working state across chained turns instead of an off/on blink between
  // them.
  private readonly pendingTurns = new Map<string, number>();

  constructor(
    store: PhiStore,
    workspaceRoot: string,
    options: AgentRuntimeOptions,
  ) {
    this.store = store;
    this.workspaceRoot = workspaceRoot;
    this.mcpPort = options.mcpPort;
    this.mcpTokens = options.mcpTokens;
    this.resolveCommand =
      options.resolveCommand ??
      ((harnessId) => harnessEntry(harnessId)?.acpCommand?.() ?? null);
  }

  handleUserMessage(message: Message): void {
    if (message.author !== "user") return;
    const threadId = message.threadId;
    // Flip the working flag synchronously, before the caller's HTTP response
    // is sent, so the thread.turn frame can never trail the send round-trip.
    const pending = (this.pendingTurns.get(threadId) ?? 0) + 1;
    this.pendingTurns.set(threadId, pending);
    if (pending === 1) {
      const agentName =
        this.sessions.get(threadId)?.agentName ??
        this.store.getThreadSession(threadId)?.agentName ??
        DEFAULT_AGENT_NAME;
      this.store.setThreadTurn(threadId, true, agentName);
    }
    const prev = this.turns.get(threadId) ?? Promise.resolve();
    // runTurn reports every failure as a message, so the chain never rejects.
    this.turns.set(
      threadId,
      prev.then(() => this.runTurn(message)),
    );
  }

  // Resolves when every turn queued for the thread so far has finished.
  settled(threadId: string): Promise<void> {
    return this.turns.get(threadId) ?? Promise.resolve();
  }

  // Sessions are in-memory, so a persisted active flag at startup means the
  // process died during that turn. Clear the flag and make the interruption
  // visible instead of leaving a permanent working state.
  recoverInterruptedTurns(): void {
    const workspace = this.store.defaultWorkspace();
    for (const turn of this.store.listActiveTurns(workspace.id)) {
      const thread = this.store.getThread(turn.threadId);
      this.store.setThreadTurn(turn.threadId, false, null);
      if (thread && thread.status !== "archived") {
        this.store.appendMessage(thread.id, {
          author: "system",
          kind: "error",
          content: "The server restarted before the agent replied.",
          metadata: { retriable: true },
        });
      }
    }
  }

  close(): void {
    for (const threadId of [...this.sessions.keys()]) {
      this.dropSession(threadId);
    }
  }

  // Releases live resources while retaining the durable binding. Archival can
  // call this; reopening the thread will resume the same harness session.
  async releaseSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    if (session.closeSupported) {
      await session.acp.connection.agent
        .request("session/close", { sessionId: session.sessionId })
        .catch(() => undefined);
    }
    this.dropSession(threadId);
  }

  private async runTurn(userMessage: Message): Promise<void> {
    const threadId = userMessage.threadId;
    try {
      const session = await this.ensureSession(threadId, userMessage);
      // handleUserMessage flagged the turn with the best name it had; correct
      // it once the session pins the actual agent.
      if (this.store.getThread(threadId)?.turnAgent !== session.agentName) {
        this.store.setThreadTurn(threadId, true, session.agentName);
      }
      session.turnText = [];
      this.mcpTokens.beginTurn(session.mcpToken);
      const recoveryContext = session.recoveryContext;
      const response = (await session.acp.connection.agent.request(
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt: [
            {
              type: "text",
              text: [
                session.primed ? undefined : MESSAGING_PREAMBLE,
                recoveryContext,
                `User request:\n${userMessage.content}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
        },
      )) as PromptResponse;
      session.primed = true;
      session.recoveryContext = undefined;

      const text = session.turnText
        .map(({ chunks }) => chunks.join("").trim())
        .filter((message) => message.length > 0)
        .join("\n\n")
        .trim();
      if (this.mcpTokens.sendCount(session.mcpToken) > 0) {
        return;
      }
      if (text.length > 0) {
        this.store.appendMessage(threadId, {
          author: "coordinator",
          kind: "message",
          content: text,
          metadata: {
            agent: session.agentName,
            stopReason: response.stopReason,
            via: "turn-text-fallback",
          },
        });
      } else {
        this.store.appendMessage(threadId, {
          author: "system",
          kind: "error",
          content: `${session.agentName} ended the turn without a reply (${response.stopReason})`,
          metadata: { retriable: true },
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
        metadata: { retriable: true },
      });
    } finally {
      const remaining = (this.pendingTurns.get(threadId) ?? 1) - 1;
      if (remaining > 0) {
        this.pendingTurns.set(threadId, remaining);
      } else {
        this.pendingTurns.delete(threadId);
        this.store.setThreadTurn(threadId, false, null);
      }
    }
  }

  private async ensureSession(
    threadId: string,
    userMessage: Message,
  ): Promise<ThreadSession> {
    const existing = this.sessions.get(threadId);
    if (existing && existing.acp.proc.exitCode === null) return existing;
    if (existing) this.dropSession(threadId);

    const binding = this.store.getThreadSession(threadId);
    const agent = binding
      ? agentFromBinding(binding)
      : await loadDefaultAgent(this.workspaceRoot);
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
      mcpToken: "",
      closeSupported: false,
      primed: false,
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
    try {
      const initialized = (await connection.agent.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
          },
        },
        { cancellationSignal: controller.signal },
      )) as InitializeResponse;
      if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
        throw new Error(
          `${agent.harness} does not support HTTP MCP, which phi agents require for send_message`,
        );
      }
      session.mcpToken = this.mcpTokens.mint({
        threadId,
        agentName: agent.name,
      });
      // Fail fast if the agent binary dies before the session exists. Create
      // this race only after capability validation so every rejection has a
      // consumer even when initialization is rejected early.
      const exited = proc.exited.then(() => {
        throw new Error(`${agent.harness} exited during session setup`);
      });
      session.closeSupported =
        initialized.agentCapabilities?.sessionCapabilities?.close != null;
      const mcpServers = this.phiMcpServers(session.mcpToken);
      let needsNewSession = binding === null;
      if (binding) {
        session.sessionId = binding.sessionId;
        try {
          if (
            initialized.agentCapabilities?.sessionCapabilities?.resume != null
          ) {
            await Promise.race([
              connection.agent.request(
                "session/resume",
                {
                  sessionId: binding.sessionId,
                  cwd: this.workspaceRoot,
                  mcpServers,
                },
                { cancellationSignal: controller.signal },
              ),
              exited,
            ]);
          } else if (initialized.agentCapabilities?.loadSession === true) {
            await Promise.race([
              connection.agent.request(
                "session/load",
                {
                  sessionId: binding.sessionId,
                  cwd: this.workspaceRoot,
                  mcpServers,
                },
                { cancellationSignal: controller.signal },
              ),
              exited,
            ]);
          } else {
            needsNewSession = true;
          }
        } catch (error) {
          if (!isUnavailableSession(error)) throw error;
          needsNewSession = true;
        }
      }
      // A resumed session's own history already opens with the preamble.
      session.primed = !needsNewSession;

      if (needsNewSession) {
        const created = (await Promise.race([
          connection.agent.request(
            "session/new",
            { cwd: this.workspaceRoot, mcpServers },
            { cancellationSignal: controller.signal },
          ),
          exited,
        ])) as NewSessionResponse;
        session.sessionId = created.sessionId;
        await this.applyAgentConfig(session, agent, created);
        this.store.saveThreadSession({
          threadId,
          harnessId: agent.harness,
          agentName: agent.name,
          sessionId: created.sessionId,
          model: agent.model,
          config: agent.config,
        });
        if (binding) {
          session.recoveryContext = this.recoveryContext(
            threadId,
            userMessage.seq,
          );
        }
      }

      // session/load replays history as updates. Phi already has a durable
      // message read model, so discard those updates before the live turn.
      session.turnText = [];
      this.sessions.set(threadId, session);
      void proc.exited.then(() => {
        if (this.sessions.get(threadId) !== session) return;
        this.sessions.delete(threadId);
        this.mcpTokens.revoke(session.mcpToken);
        connection.close();
      });
      return session;
    } catch (error) {
      if (session.mcpToken) this.mcpTokens.revoke(session.mcpToken);
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
    agent: SessionAgent,
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

  private phiMcpServers(token: string) {
    return [
      {
        type: "http" as const,
        name: "phi",
        url: `http://localhost:${this.mcpPort}/mcp`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      },
    ];
  }

  private recoveryContext(threadId: string, beforeSeq: number): string {
    const transcript = this.store
      .listMessages(threadId)
      .filter((message) => message.seq < beforeSeq)
      .filter(
        (message) => message.author !== "system" || message.kind !== "error",
      )
      .map((message) => `${message.author}: ${message.content}`)
      .join("\n\n");
    if (!transcript) return "";
    const bounded = transcript.slice(-RECOVERY_CONTEXT_MAX_CHARS);
    return [
      "Recovered context from Phi's durable thread log follows. Treat it as prior conversation, do not answer it independently, and continue with the new user request.",
      bounded,
    ].join("\n\n");
  }

  private dropSession(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.sessions.delete(threadId);
    this.mcpTokens.revoke(session.mcpToken);
    session.acp.connection.close();
    session.acp.proc.kill();
  }
}

function agentFromBinding(binding: ThreadSessionBinding): SessionAgent {
  return {
    name: binding.agentName,
    harness: binding.harnessId,
    model: binding.model,
    config: binding.config,
  };
}

function isUnavailableSession(error: unknown): boolean {
  if (error instanceof RequestError && error.code === -32601) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:session|thread).*(?:not found|unknown|does not exist)/i.test(
    message,
  );
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
