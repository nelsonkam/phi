import { PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  InitializeResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { connectAcpProcess } from "./acp-process";
import type { AcpProcess } from "./acp-process";
import { acpClientCapabilities, harnessEntry } from "./harnesses";
import { DEFAULT_AGENT_NAME, loadAgent } from "./registry";
import type { AgentDefinition } from "./registry";
import {
  routeAgentContent,
  routeDocCommentContent,
  routeUserContent,
  stripLeadingMention,
} from "./routing";
import type { MessageRouting } from "./routing";
import type { PhiStore } from "@/core/store/store";
import type { ThreadSessionBinding } from "@/core/store/store";
import type { Message } from "@/shared/types";
import type { CheckpointService } from "@/core/checkpoints";
import { CheckpointBusyError } from "@/core/checkpoints";
import { loadWorkspaceMcpConfig } from "./mcp-config";
import {
  attachmentPromptParts,
  attachmentsFromMetadata,
} from "@/server/uploads";
import {
  docSourceContext,
  formatDocCommentContext,
} from "@/core/doc-comments/source-context";
import {
  readWorkspaceFile,
  resolveMarkdownDoc,
} from "@/server/doc-comments";

const HANDSHAKE_TIMEOUT_MS = 30_000;
// JSON-RPC error code ACP agents use for `auth_required`.
const AUTH_REQUIRED_CODE = -32000;
// Sent on the first prompt of each fresh harness session only: later turns
// (and resumed sessions) already carry it in the harness's own history, and
// the phi MCP server repeats the same guidance in send_message's tool
// description and server instructions, so the model sees it every turn
// regardless. The identity sentence leads so an agent never mistakes its own
// handle for a peer it could delegate to.
export function messagingPreamble(agentName: string): string {
  return `You are @${agentName} — that handle is your own name in this thread, so work you would assign to @${agentName} is yours to do in the current turn, not a handoff. Use phi's send_message tool for every user-visible message; text outside that tool is private and will normally be discarded. Your first action must be send_message: answer immediately when the request is quick, or briefly acknowledge it and name the first concrete step. The one exception: when a turn's framing says staying silent is acceptable, ending the turn without sending anything is fine. For multi-step work, send concise updates at meaningful beats. An acknowledgement is not the result, so send the actual answer or outcome before ending the turn, then close substantial work with a short recap. Other agents' messages are peer contributions in this shared thread: address peers by handle, do not impersonate them, and rely only on tool results that appear in the shared transcript. A leading @handle on an incoming message is routing, not content; your name is attached automatically. To hand the turn to peer agents, pass their handles in send_message's to list — @mentions in your own text are display-only and never route, and a message that leads with an @agent-handle without to is rejected. To share a workspace file, link it with a workspace-relative markdown path — [the report](channels/general/report.md), or an image embed — and the app renders it viewable in place; never use absolute paths. A client-uploaded file is an attachment:att_… reference, not a workspace path — never treat a client filesystem path as a server path. Comment-thread turns are discussions on a quoted excerpt of a markdown document; when the prompt includes that excerpt, reply with send_message as usual.`;
}

// Framing for a turn triggered by a non-leading mention in a user message:
// the agent was woken because it was named, not addressed, so silence is a
// legal outcome and stray turn text is discarded rather than posted.
export const SPECULATIVE_WAKE_NOTE = `You are seeing this message because it mentions you, not because it is addressed to you. Reply through send_message only if the mention needs something from you; if it is just a reference, end the turn without sending anything — staying silent is a normal outcome here, and text outside send_message is discarded.`;

const RECOVERY_CONTEXT_MAX_CHARS = 16_000;

type SessionAgent = Pick<
  AgentDefinition,
  "name" | "harness" | "model" | "config"
>;

// One live harness process bound to one thread (see
// docs/channels-and-server.md §5). The live process is an in-memory cache; the
// harness session id is durable in PhiStore and can be resumed after restart.
interface ThreadSession {
  host: AcpHost;
  sessionId: string;
  agentName: string;
  mcpToken: string;
  mcpFingerprint: string;
  // False until the messaging preamble has reached the harness session, either
  // by this process sending it or by resuming a session whose history has it.
  primed: boolean;
  lastSeenSeq: number;
  // ACP may emit multiple logical agent messages during one turn (for example,
  // commentary followed by a final answer). Chunks within a message are deltas
  // and concatenate exactly; distinct messages retain a paragraph boundary.
  turnText: Array<{ messageId: string | undefined; chunks: string[] }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// One ACP agent process can host many logical sessions. Most harnesses use a
// single host process; Cursor hosts are keyed by their launch-time --add-dir
// set because its current ACP implementation does not advertise per-session
// additionalDirectories.
interface AcpHost {
  key: string;
  harnessId: string;
  acp: AcpProcess;
  initialized: InitializeResponse;
  sessionsById: Map<string, ThreadSession>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface AgentRuntimeOptions {
  // Test hook: resolves the ACP launch command for a harness id. Defaults to
  // the harness catalog.
  resolveCommand?: (
    harnessId: string,
    additionalDirectories?: string[],
  ) => string[] | null;
  mcpPort: number;
  mcpTokens: {
    mint(caller: { threadId: string; agentName: string }): string;
    revoke(token: string): void;
    beginTurn(token: string): void;
    sendCount(token: string): number;
  };
  hopBudget?: number;
  sessionIdleMs?: number;
  hostIdleMs?: number;
  // Test hooks: delay or reject routing so cancel races can be asserted.
  routeUserContent?: typeof routeUserContent;
  routeAgentContent?: typeof routeAgentContent;
  checkpoints?: CheckpointService;
}

// Routes stored user messages to agent sessions and writes replies back
// through the store, which broadcasts them like any other message. The
// server calls handleUserMessage after each user-message commit.
export class AgentRuntime {
  private readonly store: PhiStore;
  private readonly workspaceRoot: string;
  private readonly resolveCommand: (
    harnessId: string,
    additionalDirectories?: string[],
  ) => string[] | null;
  private readonly mcpPort: number;
  private readonly mcpTokens: AgentRuntimeOptions["mcpTokens"];
  private readonly hopBudget: number;
  private readonly sessionIdleMs: number;
  private readonly hostIdleMs: number;
  private readonly routeUserContentFn: typeof routeUserContent;
  private readonly routeAgentContentFn: typeof routeAgentContent;
  private readonly sessions = new Map<string, ThreadSession>();
  private readonly hosts = new Map<string, AcpHost>();
  private readonly startingHosts = new Map<string, Promise<AcpHost>>();
  // Per-thread promise chain; one turn runs at a time per thread and
  // messages posted mid-turn become the next turn.
  private readonly turns = new Map<string, Promise<void>>();
  // Turns queued or running per thread. The working flag flips on when the
  // count leaves zero and off when it returns, so clients see one continuous
  // working state across chained turns instead of an off/on blink between
  // them.
  private readonly pendingTurns = new Map<string, number>();
  private readonly agentHops = new Map<string, number>();
  // Bumped by cancelTurn; queued work enqueued at an older epoch is skipped.
  private readonly cancelEpoch = new Map<string, number>();
  private readonly turnAborts = new Map<string, AbortController>();
  private readonly checkpoints: CheckpointService | null;
  private workspaceActive = 0;
  private startBarrier: Promise<void> | null = null;
  private releaseStart: (() => void) | null = null;
  private closed = false;

  constructor(
    store: PhiStore,
    workspaceRoot: string,
    options: AgentRuntimeOptions,
  ) {
    this.store = store;
    this.workspaceRoot = workspaceRoot;
    this.mcpPort = options.mcpPort;
    this.mcpTokens = options.mcpTokens;
    this.hopBudget = options.hopBudget ?? 20;
    this.sessionIdleMs = options.sessionIdleMs ?? 10 * 60_000;
    this.hostIdleMs = options.hostIdleMs ?? 30_000;
    this.routeUserContentFn = options.routeUserContent ?? routeUserContent;
    this.routeAgentContentFn = options.routeAgentContent ?? routeAgentContent;
    this.checkpoints = options.checkpoints ?? null;
    this.resolveCommand =
      options.resolveCommand ??
      ((harnessId, additionalDirectories) =>
        harnessEntry(harnessId)?.acpCommand?.(additionalDirectories) ?? null);
  }

  // Pass `threadId` when routing a reply so unmentioned messages fall back to
  // the thread's own agent; omit it for a thread root, which has no history.
  async routeUserContent(
    content: string,
    threadId?: string,
  ): Promise<MessageRouting> {
    return this.routeUserContentFn(
      this.workspaceRoot,
      content,
      threadId ? this.threadFallbackAgent(threadId) : undefined,
    );
  }

  async routeDocCommentContent(content: string): Promise<MessageRouting> {
    return routeDocCommentContent(this.workspaceRoot, content);
  }

  // The agent an unmentioned reply falls back to: the last agent that
  // answered in the thread, so a follow-up continues the conversation with
  // whoever just spoke. Before any agent has replied, the thread belongs to
  // the agent its root message routed to ("@researcher ..." keeps
  // researcher). A stale name (agent since deleted) degrades to the
  // workspace default in routeUserContent.
  private threadFallbackAgent(threadId: string): string {
    const last = this.store.lastAgentMessage(threadId)?.metadata.agent;
    if (typeof last === "string" && last.length > 0) return last;
    const routed = this.store.rootMessage(threadId)?.metadata.routedTo;
    const agent = Array.isArray(routed) ? routed[0] : undefined;
    return typeof agent === "string" ? agent : DEFAULT_AGENT_NAME;
  }

  handleUserMessage(message: Message, routedTo?: string[]): void {
    if (message.author !== "user") return;
    if (routedTo?.length === 0) return;
    this.agentHops.set(message.threadId, 0);
    this.enqueueMessage(message, routedTo);
  }

  handleAgentMessage(message: Message, routedTo?: string[]): void {
    if (message.author !== "agent") return;
    if (routedTo?.length === 0) return;
    this.enqueueMessage(message, routedTo);
  }

  // Stops the running turn and drops work already queued behind it. New
  // messages after this call start a fresh epoch and run normally. Idle
  // threads return false so the HTTP handler can stay idempotent.
  cancelTurn(threadId: string): boolean {
    if ((this.pendingTurns.get(threadId) ?? 0) === 0) return false;
    this.cancelEpoch.set(threadId, (this.cancelEpoch.get(threadId) ?? 0) + 1);
    this.turnAborts.get(threadId)?.abort();
    for (const [key, session] of this.sessions) {
      if (!key.startsWith(`${threadId}\0`) || !session.sessionId) continue;
      void session.host.acp.connection.agent
        .notify("session/cancel", { sessionId: session.sessionId })
        .catch(() => undefined);
    }
    return true;
  }

  private currentEpoch(threadId: string): number {
    return this.cancelEpoch.get(threadId) ?? 0;
  }

  private wasCancelled(threadId: string, epoch: number): boolean {
    return epoch < this.currentEpoch(threadId);
  }

  private enqueueMessage(message: Message, routedTo?: string[]): void {
    if (this.closed) return;
    const threadId = message.threadId;
    // Flip the working flag synchronously, before the caller's HTTP response
    // is sent, so the thread.turn frame can never trail the send round-trip.
    const epoch = this.currentEpoch(threadId);
    const pending = (this.pendingTurns.get(threadId) ?? 0) + 1;
    this.pendingTurns.set(threadId, pending);
    if (pending === 1) {
      const agentName = routedTo?.[0] ?? this.threadFallbackAgent(threadId);
      this.store.setThreadTurn(threadId, true, agentName);
    }
    const prev = this.turns.get(threadId) ?? Promise.resolve();
    this.turns.set(
      threadId,
      prev.then(() => this.runQueued(message, routedTo, epoch)),
    );
  }

  private async runQueued(
    message: Message,
    routedTo: string[] | undefined,
    epoch: number,
  ): Promise<void> {
    while (true) {
      if (this.closed || this.wasCancelled(message.threadId, epoch)) {
        this.dropPending(message.threadId);
        return;
      }
      if (this.startBarrier) {
        await this.waitForStartBarrier();
        continue;
      }
      break;
    }
    this.workspaceActive += 1;
    try {
      await this.processMessage(message, routedTo, epoch);
    } finally {
      this.workspaceActive -= 1;
      await this.maybeIdleCheckpoint(message.threadId);
    }
  }

  private dropPending(threadId: string): void {
    const remaining = (this.pendingTurns.get(threadId) ?? 1) - 1;
    if (remaining > 0) this.pendingTurns.set(threadId, remaining);
    else {
      this.pendingTurns.delete(threadId);
      this.store.setThreadTurn(threadId, false, null);
    }
  }

  private async processMessage(
    message: Message,
    routedTo: string[] | undefined,
    epoch: number,
  ): Promise<void> {
    const threadId = message.threadId;
    try {
      if (this.wasCancelled(threadId, epoch)) return;
      const routing = await this.resolveRouting(message, routedTo);
      const metadata = { ...message.metadata, ...routing };
      message.metadata = metadata;
      this.store.updateMessageMetadata(message.id, metadata);

      const speculative = new Set(routing.speculative ?? []);
      for (const [index, agentName] of routing.routedTo.entries()) {
        // Skipped before hop accounting: a coalesced turn consumes no budget.
        if (this.turnAlreadyCovered(threadId, agentName, message.seq)) {
          continue;
        }
        if (message.author === "agent") {
          const nextHop = (this.agentHops.get(threadId) ?? 0) + 1;
          if (nextHop > this.hopBudget) {
            // The budget drops every remaining recipient, not just this one;
            // the pause message must name them all or the tail is lost
            // silently.
            const waiting = routing.routedTo.slice(index);
            const handles = waiting.map((name) => `@${name}`).join(", ");
            this.store.appendMessage(threadId, {
              author: "system",
              kind: "message",
              content: `Agent exchange paused after ${this.hopBudget} hops; ${handles} ${waiting.length === 1 ? "was" : "were"} next. Send a user message to continue.`,
              metadata: {
                reason: "agent-hop-budget",
                routedTo: waiting,
              },
            });
            break;
          }
          this.agentHops.set(threadId, nextHop);
        }
        if (this.wasCancelled(threadId, epoch)) return;
        await this.runTurn(
          message,
          agentName,
          speculative.has(agentName),
          epoch,
        );
      }
    } catch (error) {
      if (this.wasCancelled(threadId, epoch)) return;
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

  hasActiveWork(): boolean {
    if (this.closed || this.workspaceActive > 0) return true;
    for (const count of this.pendingTurns.values()) {
      if (count > 0) return true;
    }
    return false;
  }

  async withIdleExclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (true) {
      if (this.startBarrier) {
        await this.waitForStartBarrier();
        continue;
      }
      // Queued-behind-barrier work increments pendingTurns; that must not 409
      // restore. Only a live turn or shutdown is busy.
      if (this.closed || this.workspaceActive > 0) {
        throw new CheckpointBusyError();
      }
      this.holdStartBarrier();
      break;
    }
    try {
      return await fn();
    } finally {
      this.releaseStartBarrier();
    }
  }

  private async maybeIdleCheckpoint(threadId: string): Promise<void> {
    if (this.closed || !this.checkpoints) return;
    if (this.startBarrier) {
      await this.waitForStartBarrier();
      return;
    }
    if (this.workspaceActive > 0) return;
    this.holdStartBarrier();
    try {
      if (this.closed || this.workspaceActive > 0) return;
      await this.checkpoints.checkpoint({ trigger: "turn", threadId });
    } catch {
      // Capture failures degrade health; they must not fail the user turn.
    } finally {
      this.releaseStartBarrier();
    }
  }

  private holdStartBarrier(): void {
    if (this.startBarrier) return;
    this.startBarrier = new Promise((resolve) => {
      this.releaseStart = resolve;
    });
  }

  private releaseStartBarrier(): void {
    this.releaseStart?.();
    this.startBarrier = null;
    this.releaseStart = null;
  }

  private async waitForStartBarrier(): Promise<void> {
    while (this.startBarrier) await this.startBarrier;
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
        // The caller routed before committing; its speculative split rode in
        // on the message metadata.
        ...(Array.isArray(message.metadata.speculative)
          ? { speculative: message.metadata.speculative as string[] }
          : {}),
      };
    }
    if (message.author === "user") {
      if (this.store.getThread(message.threadId)?.kind === "doc_comment") {
        return routeDocCommentContent(this.workspaceRoot, message.content);
      }
      return this.routeUserContentFn(
        this.workspaceRoot,
        message.content,
        this.threadFallbackAgent(message.threadId),
      );
    }
    const authorAgent = String(message.metadata.agent ?? "");
    return this.routeAgentContentFn(
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

  close(): Promise<void> {
    return this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      await this.waitForStartBarrier();
      return;
    }
    this.closed = true;
    for (const threadId of [...this.pendingTurns.keys()]) {
      this.cancelTurn(threadId);
    }
    await Promise.all([...this.turns.values()]);
    // Restore / idle capture may still hold the start barrier; wait it out
    // so the shutdown snapshot is not mid-restore. Do not hold the barrier
    // ourselves — queued runQueued already dropped after seeing closed.
    await this.waitForStartBarrier();
    if (this.checkpoints) {
      await this.checkpoints.checkpoint({ trigger: "shutdown" });
      await this.checkpoints.flush();
      await this.checkpoints.close();
    }
    for (const session of this.sessions.values()) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      this.mcpTokens.revoke(session.mcpToken);
    }
    this.sessions.clear();
    for (const host of this.hosts.values()) {
      if (host.idleTimer) clearTimeout(host.idleTimer);
      host.acp.connection.close();
      host.acp.proc.kill();
    }
    this.hosts.clear();
    this.startingHosts.clear();
  }

  // Releases live resources while retaining the durable binding. Archival can
  // call this; reopening the thread will resume the same harness session.
  async releaseSession(threadId: string, agentName?: string): Promise<void> {
    const keys = agentName
      ? [sessionKey(threadId, agentName)]
      : [...this.sessions.keys()].filter((key) =>
          key.startsWith(`${threadId}\0`),
        );
    for (const key of keys) {
      const session = this.sessions.get(key);
      if (!session) continue;
      this.dropSessionByKey(key);
      if (
        session.host.initialized.agentCapabilities?.sessionCapabilities
          ?.close != null
      ) {
        await session.host.acp.connection.agent
          .request("session/close", { sessionId: session.sessionId })
          .catch(() => undefined);
      }
    }
  }

  private async runTurn(
    message: Message,
    agentName: string,
    speculative = false,
    epoch = 0,
  ): Promise<void> {
    const threadId = message.threadId;
    const key = sessionKey(threadId, agentName);
    const controller = new AbortController();
    this.turnAborts.set(threadId, controller);
    let session: ThreadSession | null = null;
    // The highest seq shown to the agent this turn; the seen cursor starts
    // here so messages that arrive mid-turn are never marked seen.
    let shownUpToSeq = message.seq;
    try {
      session = await this.ensureSession(threadId, agentName);
      if (this.wasCancelled(threadId, epoch) || controller.signal.aborted) {
        return;
      }
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
      const sinceThen = this.sinceThenContext(
        threadId,
        Math.max(message.seq, session.lastSeenSeq),
      );
      shownUpToSeq = Math.max(shownUpToSeq, sinceThen.upToSeq);
      const canSendImages =
        session.host.initialized.agentCapabilities?.promptCapabilities
          ?.image === true;
      const attached = await attachmentPromptParts(
        this.store.rootPath,
        attachmentsFromMetadata(message.metadata),
        canSendImages,
      );
      const response = (await session.host.acp.connection.agent.request(
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt: [
            {
              type: "text",
              text: [
                session.primed
                  ? undefined
                  : messagingPreamble(session.agentName),
                catchUpContext,
                sinceThen.text,
                speculative ? SPECULATIVE_WAKE_NOTE : undefined,
                attached.note,
                this.docCommentContext(threadId),
                routedPrompt(
                  message,
                  session.agentName,
                  catchUpContext.length > 0 ||
                    sinceThen.text.length > 0 ||
                    Boolean(attached.note) ||
                    this.store.getThread(threadId)?.kind === "doc_comment",
                ),
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
            ...attached.images,
          ],
        },
        { cancellationSignal: controller.signal },
      )) as PromptResponse;
      session.primed = true;
      if (
        response.stopReason === "cancelled" ||
        this.wasCancelled(threadId, epoch)
      ) {
        return;
      }

      const text = session.turnText
        .map(({ chunks }) => chunks.join("").trim())
        .filter((message) => message.length > 0)
        .join("\n\n")
        .trim();
      if (this.mcpTokens.sendCount(session.mcpToken) > 0) {
        return;
      }
      // A speculative wake may legitimately end in silence: contributing
      // requires the deliberate act of send_message, so stray turn text
      // (typically "no action needed" reasoning) is discarded, not posted.
      if (speculative) {
        return;
      }
      if (text.length > 0) {
        const routing = await this.routeAgentContentFn(
          this.workspaceRoot,
          text,
          session.agentName,
        );
        if (this.wasCancelled(threadId, epoch) || controller.signal.aborted) {
          return;
        }
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
      if (this.wasCancelled(threadId, epoch) || controller.signal.aborted) {
        return;
      }
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
      if (this.turnAborts.get(threadId) === controller) {
        this.turnAborts.delete(threadId);
      }
      if (session && this.sessions.get(key) === session) {
        const lastSeenSeq = this.seenCursorAfterTurn(
          threadId,
          shownUpToSeq,
          agentName,
        );
        session.lastSeenSeq = Math.max(session.lastSeenSeq, lastSeenSeq);
        this.store.advanceThreadSession(threadId, agentName, lastSeenSeq);
        this.scheduleSessionIdle(key, threadId, agentName, session);
      }
    }
  }

  private async ensureSession(
    threadId: string,
    agentName: string,
  ): Promise<ThreadSession> {
    const key = sessionKey(threadId, agentName);
    const workspaceMcp = await loadWorkspaceMcpConfig(this.workspaceRoot);
    const existing = this.sessions.get(key);
    if (
      existing &&
      existing.host.acp.proc.exitCode === null &&
      existing.mcpFingerprint === workspaceMcp.fingerprint
    ) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
      return existing;
    }
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`no thread "${threadId}"`);
    const channel = this.store.getChannel(thread.channelId);
    if (!channel) throw new Error(`no channel "${thread.channelId}"`);
    const binding = this.store.getThreadSession(threadId, agentName);
    // MCP servers are session-defining. Do not resume a live ACP session
    // after the resolved config changes; adapters are not required to
    // hot-swap servers on session/resume.
    const mcpChanged =
      existing != null
        ? existing.mcpFingerprint !== workspaceMcp.fingerprint
        : binding != null &&
          binding.mcpFingerprint !== workspaceMcp.fingerprint;
    if (existing) {
      if (
        mcpChanged &&
        existing.sessionId &&
        existing.host.initialized.agentCapabilities?.sessionCapabilities
          ?.close != null
      ) {
        await existing.host.acp.connection.agent
          .request("session/close", { sessionId: existing.sessionId })
          .catch(() => undefined);
      }
      this.dropSessionByKey(key);
    }
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
    const host = await this.ensureHost(agent.harness, channel.folders);
    const supportsAdditionalDirectories =
      host.initialized.agentCapabilities?.sessionCapabilities
        ?.additionalDirectories != null;
    if (
      channel.folders.length > 0 &&
      agent.harness !== "cursor" &&
      !supportsAdditionalDirectories
    ) {
      this.scheduleHostIdle(host);
      throw new Error(
        `${agent.harness} does not support additional channel folders over ACP`,
      );
    }
    validateMcpCapabilities(
      agent.harness,
      host.initialized,
      workspaceMcp.servers,
    );

    const session: ThreadSession = {
      host,
      sessionId: "",
      agentName: agent.name,
      mcpToken: "",
      mcpFingerprint: workspaceMcp.fingerprint,
      primed: false,
      lastSeenSeq: binding?.lastSeenSeq ?? 0,
      turnText: [],
      idleTimer: null,
    };
    const { proc, connection } = host.acp;

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
      const mcpServers = [
        ...workspaceMcp.servers,
        ...this.phiMcpServers(session.mcpToken),
      ];
      const additionalDirectories = supportsAdditionalDirectories
        ? { additionalDirectories: channel.folders }
        : {};
      let needsNewSession = binding === null || mcpChanged;
      if (binding && !mcpChanged) {
        session.sessionId = binding.sessionId;
        host.sessionsById.set(session.sessionId, session);
        try {
          if (
            host.initialized.agentCapabilities?.sessionCapabilities?.resume !=
            null
          ) {
            await Promise.race([
              connection.agent.request(
                "session/resume",
                {
                  sessionId: binding.sessionId,
                  cwd: this.workspaceRoot,
                  mcpServers,
                  ...additionalDirectories,
                },
                { cancellationSignal: controller.signal },
              ),
              exited,
            ]);
          } else if (host.initialized.agentCapabilities?.loadSession === true) {
            await Promise.race([
              connection.agent.request(
                "session/load",
                {
                  sessionId: binding.sessionId,
                  cwd: this.workspaceRoot,
                  mcpServers,
                  ...additionalDirectories,
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
          host.sessionsById.delete(binding.sessionId);
          session.sessionId = "";
          needsNewSession = true;
        }
      }
      // A resumed session's own history already opens with the preamble.
      session.primed = !needsNewSession;

      if (needsNewSession) {
        const created = (await Promise.race([
          connection.agent.request(
            "session/new",
            { cwd: this.workspaceRoot, mcpServers, ...additionalDirectories },
            { cancellationSignal: controller.signal },
          ),
          exited,
        ])) as NewSessionResponse;
        session.sessionId = created.sessionId;
        host.sessionsById.set(session.sessionId, session);
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
          mcpFingerprint: workspaceMcp.fingerprint,
        });
        const stdioStarted = workspaceMcp.servers.filter(
          (server): server is McpServer & { command: string } =>
            "command" in server && typeof server.command === "string",
        );
        if (stdioStarted.length > 0) {
          this.store.appendMessage(threadId, {
            author: "system",
            kind: "message",
            content: `Starting workspace MCP stdio ${stdioStarted.length === 1 ? "server" : "servers"}: ${stdioStarted
              .map((server) => `"${server.name}" (\`${server.command}\`)`)
              .join(", ")}.`,
            metadata: { reason: "workspace-mcp-stdio" },
          });
        }
      }

      // session/load replays history as updates. Phi already has a durable
      // message read model, so discard those updates before the live turn.
      session.turnText = [];
      this.sessions.set(key, session);
      return session;
    } catch (error) {
      if (session.mcpToken) this.mcpTokens.revoke(session.mcpToken);
      if (session.sessionId) host.sessionsById.delete(session.sessionId);
      this.scheduleHostIdle(host);
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

  private async ensureHost(
    harnessId: string,
    additionalDirectories: string[],
  ): Promise<AcpHost> {
    if (this.closed) throw new Error("agent runtime is closed");
    const key = hostKey(harnessId, additionalDirectories);
    const existing = this.hosts.get(key);
    if (existing?.acp.proc.exitCode === null) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
      return existing;
    }
    const starting = this.startingHosts.get(key);
    if (starting) return starting;

    const promise = this.startHost(key, harnessId, additionalDirectories);
    this.startingHosts.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.startingHosts.get(key) === promise) {
        this.startingHosts.delete(key);
      }
    }
  }

  private async startHost(
    key: string,
    harnessId: string,
    additionalDirectories: string[],
  ): Promise<AcpHost> {
    const command = this.resolveCommand(
      harnessId,
      harnessId === "cursor" ? additionalDirectories : undefined,
    );
    if (!command) {
      throw new Error(`harness "${harnessId}" cannot be launched over ACP`);
    }

    let host: AcpHost | null = null;
    const acp = connectAcpProcess(command, this.workspaceRoot, {
      onSessionUpdate: (notification) => {
        const session = host?.sessionsById.get(notification.sessionId);
        if (!session) return;
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
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `ACP host setup timed out after ${HANDSHAKE_TIMEOUT_MS / 1000}s`,
          ),
        ),
      HANDSHAKE_TIMEOUT_MS,
    );
    try {
      const exited = acp.proc.exited.then(() => {
        throw new Error(`${harnessId} exited during ACP initialization`);
      });
      const initialized = (await Promise.race([
        acp.connection.agent.request(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: acpClientCapabilities(harnessId),
          },
          { cancellationSignal: controller.signal },
        ),
        exited,
      ])) as InitializeResponse;
      if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
        throw new Error(
          `${harnessId} does not support HTTP MCP, which phi agents require for send_message`,
        );
      }
      host = {
        key,
        harnessId,
        acp,
        initialized,
        sessionsById: new Map(),
        idleTimer: null,
      };
      if (this.closed) throw new Error("agent runtime closed during ACP setup");
      this.hosts.set(key, host);
      void acp.proc.exited.then(() => {
        if (!host || this.hosts.get(key) !== host) return;
        this.hosts.delete(key);
        if (host.idleTimer) clearTimeout(host.idleTimer);
        for (const [sessionKeyValue, session] of this.sessions) {
          if (session.host !== host) continue;
          this.sessions.delete(sessionKeyValue);
          this.mcpTokens.revoke(session.mcpToken);
        }
        host.sessionsById.clear();
        acp.connection.close();
      });
      return host;
    } catch (error) {
      acp.connection.close();
      acp.proc.kill();
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
      await session.host.acp.connection.agent
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

  private docCommentContext(threadId: string): string | undefined {
    const thread = this.store.getThread(threadId);
    if (thread?.kind !== "doc_comment") return undefined;
    const anchor = this.store.getDocCommentAnchor(threadId);
    if (!anchor) return undefined;
    const resolved = resolveMarkdownDoc(
      this.store,
      this.workspaceRoot,
      thread.channelId,
      anchor.rootId,
      anchor.path,
    );
    if (!resolved.ok) {
      return formatDocCommentContext({
        path: anchor.path,
        quote: anchor.quote,
        surrounding: null,
      });
    }
    const source = readWorkspaceFile(resolved.file);
    if (source === null) {
      return formatDocCommentContext({
        path: anchor.path,
        quote: anchor.quote,
        surrounding: null,
      });
    }
    return formatDocCommentContext(
      docSourceContext(
        source,
        anchor.path,
        anchor.quote,
        anchor.prefix,
        anchor.suffix,
      ),
    );
  }

  // Messages that landed after the turn's trigger (or the agent's seen
  // cursor, whichever is later) before the turn began. Turns serialize, so a
  // queued turn can start well after the thread moved past its trigger — a
  // speculative wake queued behind the primary always does — and an agent
  // blind to that drift answers a thread that no longer exists (asking for a
  // plan that is already one message up, for example).
  private sinceThenContext(
    threadId: string,
    afterSeq: number,
  ): { text: string; upToSeq: number } {
    const rows = this.store
      .listMessages(threadId)
      .filter((message) => message.seq > afterSeq);
    if (rows.length === 0) return { text: "", upToSeq: afterSeq };
    const upToSeq = rows.at(-1)!.seq;
    const transcript = rows
      .filter(
        (message) => message.author !== "system" || message.kind !== "error",
      )
      .map((message) => `${messageLabel(message)}: ${message.content}`)
      .join("\n");
    if (!transcript) return { text: "", upToSeq };
    const bounded = transcript.slice(-RECOVERY_CONTEXT_MAX_CHARS);
    return {
      text: [
        "The thread has already moved past the message this turn responds to (shown last). These later messages are already in the thread — take them into account and do not repeat or re-answer what they cover:",
        bounded,
      ].join("\n\n"),
      upToSeq,
    };
  }

  // A queued turn is redundant when the agent already saw its trigger in an
  // earlier turn's context AND has spoken since: it had the trigger in view
  // and took its chance to respond. A trigger merely seen — a speculative
  // wake that chose silence — still gets its turn, so a deliberate request
  // cannot be swallowed by an earlier quiet pass over the same message.
  private turnAlreadyCovered(
    threadId: string,
    agentName: string,
    triggerSeq: number,
  ): boolean {
    const binding = this.store.getThreadSession(threadId, agentName);
    if (!binding || binding.lastSeenSeq < triggerSeq) return false;
    return this.store
      .listMessages(threadId)
      .some(
        (message) =>
          message.seq > triggerSeq &&
          message.author === "agent" &&
          message.metadata.agent === agentName,
      );
  }

  private catchUpContext(
    threadId: string,
    lastSeenSeq: number,
    beforeSeq: number,
  ): string {
    const transcript = this.store
      .listMessages(threadId)
      .filter((message) => message.seq > lastSeenSeq && message.seq < beforeSeq)
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
      if (message.author !== "agent" || message.metadata.agent !== agentName) {
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
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    this.mcpTokens.revoke(session.mcpToken);
    if (session.host.sessionsById.get(session.sessionId) === session) {
      session.host.sessionsById.delete(session.sessionId);
    }
    this.scheduleHostIdle(session.host);
  }

  private scheduleSessionIdle(
    key: string,
    threadId: string,
    agentName: string,
    session: ThreadSession,
  ): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (this.sessionIdleMs < 0) return;
    session.idleTimer = setTimeout(() => {
      if (this.sessions.get(key) !== session) return;
      void this.releaseSession(threadId, agentName);
    }, this.sessionIdleMs);
    session.idleTimer.unref?.();
  }

  private scheduleHostIdle(host: AcpHost): void {
    if (host.sessionsById.size > 0 || this.hosts.get(host.key) !== host) return;
    if (host.idleTimer) clearTimeout(host.idleTimer);
    if (this.hostIdleMs < 0) return;
    host.idleTimer = setTimeout(() => {
      if (host.sessionsById.size > 0 || this.hosts.get(host.key) !== host)
        return;
      this.hosts.delete(host.key);
      host.acp.connection.close();
      host.acp.proc.kill();
    }, this.hostIdleMs);
    host.idleTimer.unref?.();
  }
}

function validateMcpCapabilities(
  harnessId: string,
  initialized: InitializeResponse,
  servers: McpServer[],
): void {
  const capabilities = initialized.agentCapabilities?.mcpCapabilities;
  for (const server of servers) {
    if (!("type" in server)) continue; // ACP requires every agent to support stdio.
    if (server.type === "http" && capabilities?.http !== true) {
      throw new Error(
        `${harnessId} does not support HTTP MCP required by server "${server.name}"`,
      );
    }
    if (server.type === "sse" && capabilities?.sse !== true) {
      throw new Error(
        `${harnessId} does not support SSE MCP required by server "${server.name}"`,
      );
    }
  }
}

function sessionKey(threadId: string, agentName: string): string {
  return `${threadId}\0${agentName}`;
}

function hostKey(harnessId: string, additionalDirectories: string[]): string {
  return harnessId === "cursor"
    ? `${harnessId}\0${JSON.stringify(additionalDirectories)}`
    : harnessId;
}

function messageLabel(message: Message): string {
  if (message.author === "agent") {
    return `[@${String(message.metadata.agent ?? "agent")}]`;
  }
  return `[${message.author}]`;
}

// An ACP prompt is definitionally the user's channel, so a plain user message
// needs no label. Framing appears only where the channel would otherwise lie:
// a peer agent's message, or a live message that must be set apart from the
// catch-up or since-then blocks preceding it.
//
// Only user messages get their leading mention stripped: that text performed
// the routing, so it is addressing scaffold, not content (the durable log
// keeps the original). Agent messages route only through `to`, so every
// @mention in them is the sender's own words and is delivered verbatim.
function routedPrompt(
  message: Message,
  recipient: string,
  hasContext: boolean,
): string {
  if (message.author !== "user") {
    return `Message from @${String(message.metadata.agent)}:\n${message.content}`;
  }
  const content = stripLeadingMention(message.content, recipient);
  return hasContext ? `New message from the user:\n${content}` : content;
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
