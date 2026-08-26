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
import { DEFAULT_AGENT_NAME, loadAgent } from "./registry";
import type { AgentDefinition } from "./registry";
import { routeAgentContent, routeUserContent } from "./routing";
import type { MessageRouting } from "./routing";
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
export const MESSAGING_PREAMBLE = `Use phi's send_message tool for every user-visible message; text outside that tool is private and will normally be discarded. Your first action must be send_message: answer immediately when the request is quick, or briefly acknowledge it and name the first concrete step. For multi-step work, send concise updates at meaningful beats. An acknowledgement is not the result, so send the actual answer or outcome before ending the turn, then close substantial work with a short recap. Other agents' messages are peer contributions in this shared thread: address peers by handle, do not impersonate them, and rely only on tool results that appear in the shared transcript. A leading @handle on an incoming message is routing, not content — never prefix your own messages with a handle; your name is attached automatically. Lead with @name only to hand the turn to that agent.`;

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
  lastSeenSeq: number;
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
  hopBudget?: number;
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
  private readonly hopBudget: number;
  private readonly sessions = new Map<string, ThreadSession>();
  // Per-thread promise chain; one turn runs at a time per thread and
  // messages posted mid-turn become the next turn.
  private readonly turns = new Map<string, Promise<void>>();
  // Turns queued or running per thread. The working flag flips on when the
  // count leaves zero and off when it returns, so clients see one continuous
  // working state across chained turns instead of an off/on blink between
  // them.
  private readonly pendingTurns = new Map<string, number>();
  private readonly agentHops = new Map<string, number>();

  constructor(
    store: PhiStore,
    workspaceRoot: string,
    options: AgentRuntimeOptions,
  ) {
    this.store = store;
    this.workspaceRoot = workspaceRoot;
    this.mcpPort = options.mcpPort;
    this.mcpTokens = options.mcpTokens;
    this.hopBudget = options.hopBudget ?? 4;
    this.resolveCommand =
      options.resolveCommand ??
      ((harnessId) => harnessEntry(harnessId)?.acpCommand?.() ?? null);
  }

  // Pass `threadId` when routing a reply so unmentioned messages fall back to
  // the thread's own agent; omit it for a thread root, which has no history.
  async routeUserContent(
    content: string,
    threadId?: string,
  ): Promise<MessageRouting> {
    return routeUserContent(
      this.workspaceRoot,
      content,
      threadId ? this.threadFallbackAgent(threadId) : undefined,
    );
  }

  // The agent the thread's root message routed to. A thread opened with
  // "@researcher ..." belongs to researcher; unmentioned replies stay with it.
  private threadFallbackAgent(threadId: string): string {
    const routed = this.store.rootMessage(threadId)?.metadata.routedTo;
    const agent = Array.isArray(routed) ? routed[0] : undefined;
    return typeof agent === "string" ? agent : DEFAULT_AGENT_NAME;
  }

  handleUserMessage(message: Message, routedTo?: string): void {
    if (message.author !== "user") return;
    this.agentHops.set(message.threadId, 0);
    this.enqueueMessage(message, routedTo ? [routedTo] : undefined);
  }

  handleAgentMessage(message: Message, routedTo?: string[]): void {
    if (message.author !== "agent") return;
    if (routedTo?.length === 0) return;
    this.enqueueMessage(message, routedTo);
  }

  private enqueueMessage(message: Message, routedTo?: string[]): void {
    const threadId = message.threadId;
    // Flip the working flag synchronously, before the caller's HTTP response
    // is sent, so the thread.turn frame can never trail the send round-trip.
    const pending = (this.pendingTurns.get(threadId) ?? 0) + 1;
    this.pendingTurns.set(threadId, pending);
    if (pending === 1) {
      const agentName = routedTo?.[0] ?? this.threadFallbackAgent(threadId);
      this.store.setThreadTurn(threadId, true, agentName);
    }
    const prev = this.turns.get(threadId) ?? Promise.resolve();
    // runTurn reports every failure as a message, so the chain never rejects.
    this.turns.set(
      threadId,
      prev.then(() => this.processMessage(message, routedTo)),
    );
  }

  private async processMessage(
    message: Message,
    routedTo?: string[],
  ): Promise<void> {
    const threadId = message.threadId;
    try {
      const routing = await this.resolveRouting(message, routedTo);
      const metadata = { ...message.metadata, ...routing };
      message.metadata = metadata;
      this.store.updateMessageMetadata(message.id, metadata);

      for (const agentName of routing.routedTo) {
        if (message.author === "agent") {
          const nextHop = (this.agentHops.get(threadId) ?? 0) + 1;
          if (nextHop > this.hopBudget) {
            this.store.appendMessage(threadId, {
              author: "system",
              kind: "message",
              content: `Agent exchange paused after ${this.hopBudget} hops; @${agentName} was next. Send a user message to continue.`,
              metadata: {
                reason: "agent-hop-budget",
                routedTo: [agentName],
              },
            });
            break;
          }
          this.agentHops.set(threadId, nextHop);
        }
        await this.runTurn(message, agentName);
      }
    } catch (error) {
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

  private async resolveRouting(
    message: Message,
    routedTo?: string[],
  ): Promise<MessageRouting> {
    if (routedTo) {
      return {
        mentions: Array.isArray(message.metadata.mentions)
          ? (message.metadata.mentions as string[])
          : [],
        routedTo,
      };
    }
    if (message.author === "user") {
      return routeUserContent(
        this.workspaceRoot,
        message.content,
        this.threadFallbackAgent(message.threadId),
      );
    }
    const authorAgent = String(message.metadata.agent ?? "");
    return routeAgentContent(
      this.workspaceRoot,
      message.content,
      authorAgent,
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
    for (const key of [...this.sessions.keys()]) {
      this.dropSessionByKey(key);
    }
  }

  // Releases live resources while retaining the durable binding. Archival can
  // call this; reopening the thread will resume the same harness session.
  async releaseSession(threadId: string, agentName?: string): Promise<void> {
    const keys = agentName
      ? [sessionKey(threadId, agentName)]
      : [...this.sessions.keys()].filter((key) => key.startsWith(`${threadId}\0`));
    for (const key of keys) {
      const session = this.sessions.get(key);
      if (!session) continue;
      if (session.closeSupported) {
        await session.acp.connection.agent
          .request("session/close", { sessionId: session.sessionId })
          .catch(() => undefined);
      }
      this.dropSessionByKey(key);
    }
  }

  private async runTurn(message: Message, agentName: string): Promise<void> {
    const threadId = message.threadId;
    const key = sessionKey(threadId, agentName);
    let session: ThreadSession | null = null;
    try {
      session = await this.ensureSession(threadId, agentName);
      // handleUserMessage flagged the turn with the best name it had; correct
      // it once the session pins the actual agent.
      if (this.store.getThread(threadId)?.turnAgent !== session.agentName) {
        this.store.setThreadTurn(threadId, true, session.agentName);
      }
      session.turnText = [];
      this.mcpTokens.beginTurn(session.mcpToken);
      const catchUpContext = this.catchUpContext(
        threadId,
        session.lastSeenSeq,
        message.seq,
      );
      const response = (await session.acp.connection.agent.request(
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt: [
            {
              type: "text",
              text: [
                session.primed ? undefined : MESSAGING_PREAMBLE,
                catchUpContext,
                routedPrompt(
                  message,
                  session.agentName,
                  catchUpContext.length > 0,
                ),
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
        },
      )) as PromptResponse;
      session.primed = true;

      const text = session.turnText
        .map(({ chunks }) => chunks.join("").trim())
        .filter((message) => message.length > 0)
        .join("\n\n")
        .trim();
      if (this.mcpTokens.sendCount(session.mcpToken) > 0) {
        return;
      }
      if (text.length > 0) {
        const routing = await routeAgentContent(
          this.workspaceRoot,
          text,
          session.agentName,
        );
        const fallback = this.store.appendMessage(threadId, {
          author: "agent",
          kind: "message",
          content: text,
          metadata: {
            agent: session.agentName,
            stopReason: response.stopReason,
            via: "turn-text-fallback",
            ...routing,
          },
        });
        this.handleAgentMessage(fallback, routing.routedTo);
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
      this.dropSessionByKey(key);
      this.store.appendMessage(threadId, {
        author: "system",
        kind: "error",
        content: (error as Error).message,
        metadata: { retriable: true },
      });
    } finally {
      if (session && this.sessions.get(key) === session) {
        const lastSeenSeq = this.seenCursorAfterTurn(
          threadId,
          message.seq,
          agentName,
        );
        session.lastSeenSeq = Math.max(session.lastSeenSeq, lastSeenSeq);
        this.store.advanceThreadSession(threadId, agentName, lastSeenSeq);
      }
    }
  }

  private async ensureSession(
    threadId: string,
    agentName: string,
  ): Promise<ThreadSession> {
    const key = sessionKey(threadId, agentName);
    const existing = this.sessions.get(key);
    if (existing && existing.acp.proc.exitCode === null) return existing;
    if (existing) this.dropSessionByKey(key);

    const binding = this.store.getThreadSession(threadId, agentName);
    const agent = binding
      ? agentFromBinding(binding)
      : await loadAgent(this.workspaceRoot, agentName);
    if (!agent) {
      throw new Error(
        agentName === DEFAULT_AGENT_NAME
          ? "no default agent is configured; finish setup first"
          : `no agent named "${agentName}" is configured`,
      );
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
      lastSeenSeq: binding?.lastSeenSeq ?? 0,
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
        session.lastSeenSeq = 0;
        await this.applyAgentConfig(session, agent, created);
        this.store.saveThreadSession({
          threadId,
          harnessId: agent.harness,
          agentName: agent.name,
          sessionId: created.sessionId,
          model: agent.model,
          config: agent.config,
          lastSeenSeq: 0,
        });
      }

      // session/load replays history as updates. Phi already has a durable
      // message read model, so discard those updates before the live turn.
      session.turnText = [];
      this.sessions.set(key, session);
      void proc.exited.then(() => {
        if (this.sessions.get(key) !== session) return;
        this.sessions.delete(key);
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

  private catchUpContext(
    threadId: string,
    lastSeenSeq: number,
    beforeSeq: number,
  ): string {
    const transcript = this.store
      .listMessages(threadId)
      .filter(
        (message) =>
          message.seq > lastSeenSeq && message.seq < beforeSeq,
      )
      .filter(
        (message) => message.author !== "system" || message.kind !== "error",
      )
      .map((message) => `${messageLabel(message)}: ${message.content}`)
      .join("\n");
    if (!transcript) return "";
    const bounded = transcript.slice(-RECOVERY_CONTEXT_MAX_CHARS);
    return [
      "Prior conversation from Phi's durable thread log follows. Treat it as context, do not answer it independently; the new message to respond to comes after it.",
      bounded,
    ].join("\n\n");
  }

  private seenCursorAfterTurn(
    threadId: string,
    currentSeq: number,
    agentName: string,
  ): number {
    let cursor = currentSeq;
    for (const message of this.store.listMessages(threadId)) {
      if (message.seq <= cursor) continue;
      // An agent sees the messages it sends during its own turn. Stop at the
      // first other row so a user message committed concurrently cannot be
      // skipped by a later self-authored update.
      if (
        message.author !== "agent" ||
        message.metadata.agent !== agentName
      ) {
        break;
      }
      cursor = message.seq;
    }
    return cursor;
  }

  private dropSessionByKey(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    this.mcpTokens.revoke(session.mcpToken);
    session.acp.connection.close();
    session.acp.proc.kill();
  }
}

function sessionKey(threadId: string, agentName: string): string {
  return `${threadId}\0${agentName}`;
}

function messageLabel(message: Message): string {
  if (message.author === "agent") {
    return `[@${String(message.metadata.agent ?? "agent")}]`;
  }
  return `[${message.author}]`;
}

// The leading mention that routed a message to `recipient` is addressing, not
// content; strip it so the model never sees scaffolding to imitate. The
// durable log keeps the original text.
function stripRoutedMention(content: string, recipient: string): string {
  const match = content.match(/^\s*@([a-z0-9][a-z0-9-]*)\s*/i);
  if (!match || match[1]!.toLowerCase() !== recipient.toLowerCase()) {
    return content;
  }
  const rest = content.slice(match[0].length);
  return rest.length > 0 ? rest : content;
}

// An ACP prompt is definitionally the user's channel, so a plain user message
// needs no label. Framing appears only where the channel would otherwise lie:
// a peer agent's message, or a live message that must be set apart from the
// catch-up block preceding it.
function routedPrompt(
  message: Message,
  recipient: string,
  hasCatchUp: boolean,
): string {
  const content = stripRoutedMention(message.content, recipient);
  if (message.author !== "user") {
    return `Message from @${String(message.metadata.agent)}:\n${content}`;
  }
  return hasCatchUp ? `New message from the user:\n${content}` : content;
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
