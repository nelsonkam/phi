import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tempDir } from "@/testing/tmpdir";
import { PhiStore } from "@/core/store/store";
import { ensureWorkspace } from "@/core/workspace";
import { writeAgent, writeDefaultAgent } from "@/core/agents/registry";
import { AgentRuntime, messagingPreamble } from "@/core/agents/runtime";
import type { MessageRouting } from "@/core/agents/routing";
import { createMcpHandler } from "@/server/mcp";
import { McpTokenRegistry } from "@/server/mcp-token-registry";
import type { Channel } from "@/shared/types";
import { CheckpointBusyError, CheckpointService } from "@/core/checkpoints";

const FAKE_AGENT = join(import.meta.dir, "fixtures", "fake-acp-agent.ts");

interface Fixture {
  store: PhiStore;
  runtime: AgentRuntime;
  channel: Channel;
  mcpPort: number;
  mcpTokens: McpTokenRegistry;
  launches: Array<{ harnessId: string; additionalDirectories?: string[] }>;
  checkpoints: CheckpointService | null;
  done: () => Promise<void>;
}

async function fixture(options?: {
  agent?: false;
  agentArgs?: string[];
  harness?: "claude-code" | "codex" | "cursor" | "gemini";
  sessionIdleMs?: number;
  hostIdleMs?: number;
  hopBudget?: number;
  withCheckpoints?: boolean;
  routeUserContent?: ConstructorParameters<
    typeof AgentRuntime
  >[2]["routeUserContent"];
  routeAgentContent?: ConstructorParameters<
    typeof AgentRuntime
  >[2]["routeAgentContent"];
}): Promise<Fixture> {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  ensureWorkspace(workspace.rootPath);
  if (options?.agent !== false) {
    await writeDefaultAgent(workspace.rootPath, {
      harness: options?.harness ?? "claude-code",
      model: "smart",
    });
  }
  const mcpTokens = new McpTokenRegistry();
  const mcpHandler = createMcpHandler(store, mcpTokens);
  const mcpServer = Bun.serve({
    port: 0,
    fetch: (req) => mcpHandler(req),
  });
  const launches: Fixture["launches"] = [];
  const checkpoints = options?.withCheckpoints
    ? new CheckpointService(store, workspace.rootPath)
    : null;
  if (checkpoints) await checkpoints.initialize();
  const runtime = new AgentRuntime(store, workspace.rootPath, {
    mcpPort: mcpServer.port!,
    mcpTokens,
    sessionIdleMs: options?.sessionIdleMs,
    hostIdleMs: options?.hostIdleMs,
    hopBudget: options?.hopBudget,
    routeUserContent: options?.routeUserContent,
    routeAgentContent: options?.routeAgentContent,
    ...(checkpoints ? { checkpoints } : {}),
    resolveCommand: (harnessId, additionalDirectories) => {
      launches.push({ harnessId, additionalDirectories });
      return [process.execPath, FAKE_AGENT, ...(options?.agentArgs ?? [])];
    },
  });
  const channel = store.listChannels(workspace.id)[0]!;
  const done = async () => {
    await runtime.close();
    void mcpServer.stop(true);
    store.close();
  };
  return {
    store,
    runtime,
    channel,
    mcpPort: mcpServer.port!,
    mcpTokens,
    launches,
    checkpoints,
    done,
  };
}

test("the messaging preamble opens with the agent's own handle", () => {
  const preamble = messagingPreamble("reviewer");
  expect(preamble.startsWith("You are @reviewer — ")).toBe(true);
  // The fake agent's "[intro]" marker keys on this sentence; every content
  // assertion carrying "[intro]" also proves the identity reached the prompt.
  expect(preamble).toContain("that handle is your own name in this thread");
  expect(preamble).toContain("attachment:att_");
  expect(preamble).toContain("Comment-thread turns");
});

test("a user message gets the agent's reply appended to its thread", async () => {
  const { store, runtime, channel, done } = await fixture();
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "hello agent",
  });
  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);

  const messages = store.listMessages(thread.id);
  expect(messages).toHaveLength(2);
  const reply = messages[1]!;
  expect(reply.author).toBe("agent");
  // "[model=smart]" proves the agent's saved model reached the session's
  // model config option before the prompt; "[intro]" proves the fresh
  // session's first prompt carried the messaging preamble.
  expect(reply.content).toBe("[model=smart] [intro] echo#1: hello agent");
  expect(reply.metadata).toEqual({
    agent: "default",
    mentions: [],
    routedTo: [],
    stopReason: "end_turn",
    via: "turn-text-fallback",
  });
  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  await done();
});

test("a doc-comment turn includes the anchored excerpt in the prompt", async () => {
  const { store, runtime, channel, done } = await fixture();
  const workspace = store.defaultWorkspace();
  mkdirSync(join(workspace.rootPath, "channels", "general"), { recursive: true });
  writeFileSync(
    join(workspace.rootPath, "channels", "general", "notes.md"),
    "# Intro\n\nThe unique quote lives here.\n",
  );
  const { thread, message } = store.createDocComment(
    channel.id,
    { author: "user", kind: "message", content: "@default what about this?" },
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      quote: "unique quote",
      prefix: "The ",
      suffix: " lives",
      headingSlug: "intro",
    },
  );
  const routing = await runtime.routeDocCommentContent(message.content);
  runtime.handleUserMessage(message, routing.routedTo);
  await runtime.settled(thread.id);
  const reply = store.listMessages(thread.id).at(-1)!;
  expect(reply.content).toContain("[doc-comment]");
  expect(reply.content).toContain("what about this?");
  await done();
});

test("an unmentioned doc-comment does not start a turn", async () => {
  const { store, runtime, channel, done } = await fixture();
  const { thread, message } = store.createDocComment(
    channel.id,
    { author: "user", kind: "message", content: "looks off" },
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      quote: "unique quote",
      prefix: "The ",
      suffix: " lives",
      headingSlug: "intro",
    },
  );
  const routing = await runtime.routeDocCommentContent(message.content);
  expect(routing).toEqual({ mentions: [], routedTo: [] });
  runtime.handleUserMessage(message, routing.routedTo);
  await runtime.settled(thread.id);
  expect(store.listMessages(thread.id)).toHaveLength(1);
  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  await done();
});

test("user attachments are listed in the prompt and images embed when supported", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const { store, runtime, channel, done } = await fixture({
    agentArgs: ["images"],
  });
  const id = `att_${"d".repeat(32)}`;
  mkdirSync(join(store.rootPath, "uploads"), { recursive: true });
  writeFileSync(join(store.rootPath, "uploads", id), png);
  const attachment = store.createAttachment({
    id,
    workspaceId: store.defaultWorkspace().id,
    filename: "shot.png",
    contentType: "image/png",
    byteSize: png.byteLength,
  });
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "what is this",
    metadata: { attachments: [attachment] },
  });
  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);
  const reply = store.listMessages(thread.id)[1]!;
  expect(reply.content).toContain("[attach]");
  expect(reply.content).toContain("[image:image/png]");
  expect(reply.content).toContain("what is this");
  await done();
});

test("a settled workspace captures one checkpoint", async () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  ensureWorkspace(workspace.rootPath);
  await writeDefaultAgent(workspace.rootPath, {
    harness: "claude-code",
    model: "smart",
  });
  const checkpoints = new CheckpointService(store, workspace.rootPath);
  await checkpoints.initialize();
  const before = store.listCheckpoints(workspace.id).length;
  const mcpTokens = new McpTokenRegistry();
  const mcpHandler = createMcpHandler(store, mcpTokens);
  const mcpServer = Bun.serve({ port: 0, fetch: (req) => mcpHandler(req) });
  const runtime = new AgentRuntime(store, workspace.rootPath, {
    mcpPort: mcpServer.port!,
    mcpTokens,
    checkpoints,
    resolveCommand: () => [process.execPath, FAKE_AGENT],
  });
  const channel = store.listChannels(workspace.id)[0]!;
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "checkpoint me",
  });
  writeFileSync(join(workspace.rootPath, "channels", "t.md"), "hi\n");
  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);
  await checkpoints.flush();
  expect(store.listCheckpoints(workspace.id).length).toBeGreaterThan(before);
  await runtime.close();
  void mcpServer.stop(true);
  store.close();
});

test("send_message is delivered live and suppresses private turn text", async () => {
  const { store, runtime, channel, done } = await fixture({
    agentArgs: ["tool"],
  });
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "do the work",
  });
  let activeWhenDelivered = false;
  store.onChange = (change) => {
    if (
      change.type === "message.appended" &&
      change.message.author === "agent"
    ) {
      activeWhenDelivered = store.getThread(thread.id)!.turnActive;
    }
  };

  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);

  const replies = store
    .listMessages(thread.id)
    .filter((item) => item.author === "agent");
  expect(replies).toHaveLength(1);
  expect(replies[0]!.content).toBe("tool#1: do the work");
  expect(replies[0]!.metadata).toEqual({
    agent: "default",
    mentions: [],
    routedTo: [],
  });
  expect(activeWhenDelivered).toBe(true);
  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  await done();
});

test("a silent turn becomes a system error", async () => {
  const { store, runtime, channel, done } = await fixture({
    agentArgs: ["silent"],
  });
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "say something",
  });

  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);

  const reply = store.listMessages(thread.id)[1]!;
  expect(reply.author).toBe("system");
  expect(reply.content).toContain("ended the turn without a reply");
  await done();
});

test("rejects harnesses without HTTP MCP support", async () => {
  const { store, runtime, channel, done } = await fixture({
    agentArgs: ["no-http"],
  });
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "hello",
  });

  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);

  expect(store.listMessages(thread.id)[1]!.content).toContain(
    "does not support HTTP MCP",
  );
  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  await done();
});

test("announces workspace MCP servers alongside phi", async () => {
  const { store, runtime, channel, done } = await fixture({
    agentArgs: ["mcps"],
  });
  writeFileSync(
    join(store.defaultWorkspace().rootPath, ".agents", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        remote: { url: "https://example.com/mcp" },
      },
    }),
  );
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "hello",
  });

  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);

  expect(store.listMessages(thread.id)[1]!.content).toContain(
    "[mcps=remote,phi]",
  );
  await done();
});

test("rejects workspace MCP transports the harness does not advertise", async () => {
  const { store, runtime, channel, done } = await fixture();
  writeFileSync(
    join(store.defaultWorkspace().rootPath, ".agents", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        events: { type: "sse", url: "https://example.com/sse", headers: {} },
      },
    }),
  );
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "hello",
  });

  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);

  expect(store.listMessages(thread.id)[1]!.content).toContain(
    'does not support SSE MCP required by server "events"',
  );
  await done();
});

test("refreshes a live session when workspace MCP configuration changes", async () => {
  const { store, runtime, channel, done } = await fixture({
    agentArgs: ["mcps", "reject-closed"],
  });
  const configPath = join(
    store.defaultWorkspace().rootPath,
    ".agents",
    "mcp.json",
  );
  const writeRemote = (name: string) =>
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          [name]: { type: "http", url: "https://example.com/mcp", headers: {} },
        },
      }),
    );
  writeRemote("first");
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "one",
  });
  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);
  const firstSessionId = store.getThreadSession(thread.id)!.sessionId;

  writeRemote("second");
  const second = store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "two",
  });
  runtime.handleUserMessage(second);
  await runtime.settled(thread.id);

  const replies = store
    .listMessages(thread.id)
    .filter((item) => item.author === "agent")
    .map((item) => item.content);
  expect(replies[0]).toContain("[mcps=first,phi]");
  expect(replies[1]).toContain("[mcps=second,phi]");
  expect(store.getThreadSession(thread.id)!.sessionId).not.toBe(firstSessionId);
  expect(store.getThreadSession(thread.id)!.mcpFingerprint).toHaveLength(64);
  await done();
});

test("replaces a durable session when MCP config changed while phi was stopped", async () => {
  const { store, runtime, channel, mcpPort, mcpTokens, done } = await fixture({
    agentArgs: ["mcps"],
  });
  const configPath = join(
    store.defaultWorkspace().rootPath,
    ".agents",
    "mcp.json",
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        first: { url: "https://example.com/mcp" },
      },
    }),
  );
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "one",
  });
  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);
  const firstSessionId = store.getThreadSession(thread.id)!.sessionId;
  await runtime.close();

  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        second: { url: "https://example.com/mcp" },
      },
    }),
  );
  const restarted = new AgentRuntime(
    store,
    store.defaultWorkspace().rootPath,
    {
      mcpPort,
      mcpTokens,
      resolveCommand: () => [process.execPath, FAKE_AGENT, "mcps"],
    },
  );
  const second = store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "two",
  });
  restarted.handleUserMessage(second);
  await restarted.settled(thread.id);

  expect(store.getThreadSession(thread.id)!.sessionId).not.toBe(firstSessionId);
  expect(
    store
      .listMessages(thread.id)
      .filter((item) => item.author === "agent")
      .at(-1)!.content,
  ).toContain("[mcps=second,phi]");
  await restarted.close();
  await done();
});

test("surfaces resolved stdio commands when a session starts with workspace MCP", async () => {
  const { store, runtime, channel, done } = await fixture();
  const envPath = Bun.which("env");
  expect(envPath).toBeTruthy();
  writeFileSync(
    join(store.defaultWorkspace().rootPath, ".agents", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        local: { command: "env", args: ["true"] },
      },
    }),
  );
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "hello",
  });
  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);

  const notice = store
    .listMessages(thread.id)
    .find((item) => item.metadata.reason === "workspace-mcp-stdio");
  expect(notice?.author).toBe("system");
  expect(notice?.content).toContain('"local"');
  expect(notice?.content).toContain(`\`${envPath}\``);
  await done();
});

test("recovers only threads with a persisted active turn", async () => {
  const { store, runtime, channel, done } = await fixture();
  const interrupted = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "interrupted",
  });
  const idle = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "idle",
  });
  store.setThreadTurn(interrupted.thread.id, true, "default");

  runtime.recoverInterruptedTurns();

  expect(store.getThread(interrupted.thread.id)!.turnActive).toBe(false);
  const recovery = store.listMessages(interrupted.thread.id).at(-1)!;
  expect(recovery.author).toBe("system");
  // Clients key the retry affordance off this flag.
  expect(recovery.metadata.retriable).toBe(true);
  expect(store.listMessages(idle.thread.id)).toHaveLength(1);
  await done();
});

test("cancelTurn is a no-op when the thread is idle", async () => {
  const { store, runtime, channel, done } = await fixture();
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "idle",
  });
  expect(runtime.cancelTurn(thread.id)).toBe(false);
  await done();
});

test("cancelTurn skips a turn that has not started and leaves no error", async () => {
  const { store, runtime, channel, done } = await fixture();
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "stop me",
  });
  runtime.handleUserMessage(message);
  expect(runtime.cancelTurn(thread.id)).toBe(true);
  await runtime.settled(thread.id);

  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  expect(store.listMessages(thread.id).map((item) => item.author)).toEqual([
    "user",
  ]);
  await done();
});

test("a message after cancel still runs", async () => {
  const { store, runtime, channel, done } = await fixture();
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "first",
  });
  runtime.handleUserMessage(message);
  expect(runtime.cancelTurn(thread.id)).toBe(true);
  await runtime.settled(thread.id);

  runtime.handleUserMessage(
    store.appendMessage(thread.id, {
      author: "user",
      kind: "message",
      content: "second",
    }),
  );
  await runtime.settled(thread.id);

  const replies = store
    .listMessages(thread.id)
    .filter((item) => item.author === "agent");
  expect(replies).toHaveLength(1);
  expect(replies[0]!.content).toContain("echo#1: second");
  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  await done();
});

test("cancelTurn stops an in-flight prompt via session/cancel", async () => {
  const { store, runtime, channel, done } = await fixture({
    agentArgs: ["slow"],
  });
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "hang",
  });
  runtime.handleUserMessage(message);
  await Bun.sleep(100);
  expect(store.getThread(thread.id)!.turnActive).toBe(true);
  expect(runtime.cancelTurn(thread.id)).toBe(true);
  await runtime.settled(thread.id);

  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  expect(store.listMessages(thread.id).map((item) => item.author)).toEqual([
    "user",
  ]);
  await done();
});

test("cancel during a routing reject does not append a system error", async () => {
  let rejectRouting!: (error: Error) => void;
  const blocked = new Promise<MessageRouting>((_resolve, reject) => {
    rejectRouting = reject;
  });
  let started!: () => void;
  const routingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { store, runtime, channel, done } = await fixture({
    routeUserContent: () => {
      started();
      return blocked;
    },
  });
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "route then fail",
  });
  runtime.handleUserMessage(message);
  await routingStarted;
  expect(runtime.cancelTurn(thread.id)).toBe(true);
  rejectRouting(new Error("routing exploded"));
  await runtime.settled(thread.id);

  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  expect(store.listMessages(thread.id).map((item) => item.author)).toEqual([
    "user",
  ]);
  await done();
});

test("cancel during fallback reply routing does not append the agent reply", async () => {
  let finishRouting!: (value: MessageRouting) => void;
  const blocked = new Promise<MessageRouting>((resolve) => {
    finishRouting = resolve;
  });
  let started!: () => void;
  const routingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { store, runtime, channel, done } = await fixture({
    routeAgentContent: async () => {
      started();
      return blocked;
    },
  });
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "fallback",
  });
  runtime.handleUserMessage(message);
  await routingStarted;
  expect(runtime.cancelTurn(thread.id)).toBe(true);
  finishRouting({ mentions: [], routedTo: [] });
  await runtime.settled(thread.id);

  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  expect(store.listMessages(thread.id).map((item) => item.author)).toEqual([
    "user",
  ]);
  await done();
});

test("cancelTurn drops queued follow-up turns", async () => {
  const { store, runtime, channel, done } = await fixture({
    agentArgs: ["slow"],
  });
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "first",
  });
  runtime.handleUserMessage(message);
  runtime.handleUserMessage(
    store.appendMessage(thread.id, {
      author: "user",
      kind: "message",
      content: "second",
    }),
  );
  await Bun.sleep(100);
  expect(runtime.cancelTurn(thread.id)).toBe(true);
  await runtime.settled(thread.id);

  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  expect(
    store.listMessages(thread.id).filter((item) => item.author === "agent"),
  ).toHaveLength(0);
  await done();
});

test("turns in one thread serialize and reuse one session", async () => {
  const { store, runtime, channel, done } = await fixture();
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "first",
  });
  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);
  runtime.handleUserMessage(
    store.appendMessage(thread.id, {
      author: "user",
      kind: "message",
      content: "second",
    }),
  );
  await runtime.settled(thread.id);

  const replies = store
    .listMessages(thread.id)
    .filter((m) => m.author === "agent")
    .map((m) => m.content);
  // The fake's turn counter is per process, so "#2" proves session reuse,
  // and the missing "[intro]" proves the preamble is sent only once per
  // session.
  expect(replies).toEqual([
    "[model=smart] [intro] echo#1: first",
    "[model=smart] echo#2: second",
  ]);
  await done();
});

test("a turn sees messages that landed after its trigger; the covered turn coalesces", async () => {
  const { store, runtime, channel, done } = await fixture();
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "first",
  });
  // Both messages are committed before the first turn starts, so the first
  // turn's prompt carries the second message as since-then context.
  runtime.handleUserMessage(message);
  runtime.handleUserMessage(
    store.appendMessage(thread.id, {
      author: "user",
      kind: "message",
      content: "second",
    }),
  );
  await runtime.settled(thread.id);

  const replies = store
    .listMessages(thread.id)
    .filter((m) => m.author === "agent")
    .map((m) => m.content);
  // One reply, not two: the first turn saw both messages ("[since]"), so the
  // queued turn for "second" — already seen and already answered — is
  // skipped instead of prompting a stale re-answer.
  expect(replies).toEqual(["[model=smart] [intro] [since] echo#1: first"]);
  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  await done();
});

test("a silent speculative pass does not swallow a later deliberate turn", async () => {
  const { store, runtime, channel, done } = await fixture();
  await writeAgent(store.defaultWorkspace().rootPath, "reviewer", {
    harness: "codex",
    instructions: "Review the request.",
  });
  const root = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "start work, maybe ask @reviewer",
  });
  const handoff = store.appendMessage(root.thread.id, {
    author: "agent",
    kind: "message",
    content: "please review",
    metadata: { agent: "default" },
  });
  // Queue order: default's primary turn, reviewer's speculative turn (which
  // sees the handoff as since-then context but stays silent — echo turn text
  // is discarded), then the deliberate turn for the handoff. The coalescing
  // guard must not skip that last turn: reviewer saw the handoff but never
  // spoke.
  runtime.handleUserMessage(root.message);
  runtime.handleAgentMessage(handoff, ["reviewer"]);
  await runtime.settled(root.thread.id);

  const reviewerReplies = store
    .listMessages(root.thread.id)
    .filter((m) => m.author === "agent" && m.metadata.agent === "reviewer");
  expect(reviewerReplies).toHaveLength(1);
  expect(reviewerReplies[0]!.content).toContain("echo#2: please review");
  await done();
});

test("threads get separate sessions on one pooled harness process", async () => {
  const { store, runtime, channel, launches, done } = await fixture();
  const first = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "thread one",
  });
  const second = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "thread two",
  });
  runtime.handleUserMessage(first.message);
  runtime.handleUserMessage(second.message);
  await runtime.settled(first.thread.id);
  await runtime.settled(second.thread.id);

  // Both threads see turn #1 because their logical sessions are isolated,
  // while one launch proves they share the harness process.
  expect(store.listMessages(first.thread.id)[1]!.content).toBe(
    "[model=smart] [intro] echo#1: thread one",
  );
  expect(store.listMessages(second.thread.id)[1]!.content).toBe(
    "[model=smart] [intro] echo#1: thread two",
  );
  expect(launches).toHaveLength(1);
  await done();
});

test("passes channel folders as ACP additional directories", async () => {
  const { store, runtime, launches, done } = await fixture({
    agentArgs: ["roots"],
  });
  const workspace = store.defaultWorkspace();
  const folders = [tempDir(), tempDir()];
  const channel = store.createChannel(workspace.id, {
    name: "external-projects",
    folders,
  });
  const root = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "inspect roots",
  });

  runtime.handleUserMessage(root.message);
  await runtime.settled(root.thread.id);

  expect(store.listMessages(root.thread.id).at(-1)!.content).toContain(
    `[roots=${folders.join(",")}]`,
  );
  // Standard ACP roots are session-scoped, not process launch arguments.
  expect(launches).toEqual([
    { harnessId: "claude-code", additionalDirectories: undefined },
  ]);
  await done();
});

test("evicts idle sessions and empty pooled hosts", async () => {
  const { store, runtime, channel, launches, done } = await fixture({
    sessionIdleMs: 5,
    hostIdleMs: 5,
  });
  const root = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "first",
  });
  runtime.handleUserMessage(root.message);
  await runtime.settled(root.thread.id);
  await Bun.sleep(30);

  const second = store.appendMessage(root.thread.id, {
    author: "user",
    kind: "message",
    content: "second",
  });
  runtime.handleUserMessage(second);
  await runtime.settled(root.thread.id);

  expect(launches).toHaveLength(2);
  expect(store.listMessages(root.thread.id).at(-1)!.content).toBe(
    "[model=smart] echo#2: second",
  );
  await done();
});

test("pools Cursor by channel folder set and passes launch-time roots", async () => {
  const { store, runtime, launches, done } = await fixture({
    harness: "cursor",
  });
  const workspace = store.defaultWorkspace();
  const firstFolders = [tempDir(), tempDir()];
  const secondFolders = [tempDir()];
  const firstChannel = store.createChannel(workspace.id, {
    name: "cursor-one",
    folders: firstFolders,
  });
  const secondChannel = store.createChannel(workspace.id, {
    name: "cursor-two",
    folders: secondFolders,
  });
  const messages = [
    store.createThread(firstChannel.id, {
      author: "user",
      kind: "message",
      content: "first",
    }),
    store.createThread(firstChannel.id, {
      author: "user",
      kind: "message",
      content: "second",
    }),
    store.createThread(secondChannel.id, {
      author: "user",
      kind: "message",
      content: "third",
    }),
  ];

  for (const item of messages) runtime.handleUserMessage(item.message);
  await Promise.all(messages.map((item) => runtime.settled(item.thread.id)));

  expect(launches).toEqual([
    { harnessId: "cursor", additionalDirectories: firstFolders },
    { harnessId: "cursor", additionalDirectories: secondFolders },
  ]);
  await done();
});

test("a thread resumes its durable session after the live process closes", async () => {
  const { store, runtime, channel, mcpPort, mcpTokens, done } = await fixture();
  const first = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "first",
  });
  runtime.handleUserMessage(first.message);
  await runtime.settled(first.thread.id);

  const binding = store.getThreadSession(first.thread.id)!;
  expect(binding).toMatchObject({
    harnessId: "claude-code",
    agentName: "default",
    model: "smart",
    config: {},
  });
  await runtime.releaseSession(first.thread.id);

  const resumedRuntime = new AgentRuntime(
    store,
    store.defaultWorkspace().rootPath,
    {
      mcpPort,
      mcpTokens,
      resolveCommand: () => [process.execPath, FAKE_AGENT],
    },
  );
  const second = store.appendMessage(first.thread.id, {
    author: "user",
    kind: "message",
    content: "second",
  });
  resumedRuntime.handleUserMessage(second);
  await resumedRuntime.settled(first.thread.id);

  expect(store.getThreadSession(first.thread.id)!.sessionId).toBe(
    binding.sessionId,
  );
  // No "[intro]": the resumed session's history already has the preamble.
  expect(store.listMessages(first.thread.id).at(-1)!.content).toBe(
    "[model=smart] echo#2: second",
  );
  await resumedRuntime.close();
  await done();
});

test("session/load restores context without duplicating replayed messages", async () => {
  const { store, runtime, channel, mcpPort, mcpTokens, done } = await fixture({
    agentArgs: ["load-only"],
  });
  const first = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "first",
  });
  runtime.handleUserMessage(first.message);
  await runtime.settled(first.thread.id);
  const binding = store.getThreadSession(first.thread.id)!;
  await runtime.close();

  const loadedRuntime = new AgentRuntime(
    store,
    store.defaultWorkspace().rootPath,
    {
      mcpPort,
      mcpTokens,
      resolveCommand: () => [process.execPath, FAKE_AGENT, "load-only"],
    },
  );
  const second = store.appendMessage(first.thread.id, {
    author: "user",
    kind: "message",
    content: "second",
  });
  loadedRuntime.handleUserMessage(second);
  await loadedRuntime.settled(first.thread.id);

  expect(store.getThreadSession(first.thread.id)!.sessionId).toBe(
    binding.sessionId,
  );
  expect(
    store
      .listMessages(first.thread.id)
      .filter((message) => message.author === "agent")
      .map((message) => message.content),
  ).toEqual([
    "[model=smart] [intro] echo#1: first",
    // No "[intro]" after session/load: the restored history has the preamble.
    "[model=smart] echo#2: second",
  ]);
  await loadedRuntime.close();
  await done();
});

test("a non-resumable harness replaces the session with recovered context", async () => {
  const { store, runtime, channel, mcpPort, mcpTokens, done } = await fixture({
    agentArgs: ["no-resume"],
  });
  const first = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "first",
  });
  runtime.handleUserMessage(first.message);
  await runtime.settled(first.thread.id);
  const originalSessionId = store.getThreadSession(first.thread.id)!.sessionId;
  await runtime.close();

  const replacementRuntime = new AgentRuntime(
    store,
    store.defaultWorkspace().rootPath,
    {
      mcpPort,
      mcpTokens,
      resolveCommand: () => [process.execPath, FAKE_AGENT, "no-resume"],
    },
  );
  const second = store.appendMessage(first.thread.id, {
    author: "user",
    kind: "message",
    content: "second",
  });
  replacementRuntime.handleUserMessage(second);
  await replacementRuntime.settled(first.thread.id);

  expect(store.getThreadSession(first.thread.id)!.sessionId).not.toBe(
    originalSessionId,
  );
  // "[intro]": the replacement session starts fresh, so it is re-primed.
  expect(store.listMessages(first.thread.id).at(-1)!.content).toBe(
    "[model=smart] [intro] [catchup] echo#1: second",
  );
  await replacementRuntime.close();
  await done();
});

test("a missing durable harness session is replaced", async () => {
  const { store, runtime, channel, mcpPort, mcpTokens, done } = await fixture();
  const first = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "first",
  });
  runtime.handleUserMessage(first.message);
  await runtime.settled(first.thread.id);
  const originalSessionId = store.getThreadSession(first.thread.id)!.sessionId;
  await runtime.close();

  const replacementRuntime = new AgentRuntime(
    store,
    store.defaultWorkspace().rootPath,
    {
      mcpPort,
      mcpTokens,
      resolveCommand: () => [process.execPath, FAKE_AGENT, "resume-missing"],
    },
  );
  const second = store.appendMessage(first.thread.id, {
    author: "user",
    kind: "message",
    content: "second",
  });
  replacementRuntime.handleUserMessage(second);
  await replacementRuntime.settled(first.thread.id);

  expect(store.getThreadSession(first.thread.id)!.sessionId).not.toBe(
    originalSessionId,
  );
  expect(store.listMessages(first.thread.id).at(-1)!.content).toBe(
    "[model=smart] [intro] [catchup] echo#1: second",
  );
  await replacementRuntime.close();
  await done();
});

test("a missing default agent becomes a system error message", async () => {
  const { store, runtime, channel, done } = await fixture({ agent: false });
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "anyone there?",
  });
  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);

  const reply = store.listMessages(thread.id)[1]!;
  expect(reply.author).toBe("system");
  expect(reply.kind).toBe("error");
  expect(reply.content).toContain("no default agent");
  await done();
});

test("auth_required surfaces the harness login hint", async () => {
  const { store, runtime, channel, done } = await fixture({
    agentArgs: ["auth"],
  });
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "hi",
  });
  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);

  const reply = store.listMessages(thread.id)[1]!;
  expect(reply.author).toBe("system");
  expect(reply.content).toContain("not logged in");
  expect(reply.content).toContain("claude /login");
  await done();
});

test("a leading mention lazily creates a separate agent session with catch-up", async () => {
  const { store, runtime, channel, done } = await fixture();
  await writeAgent(store.defaultWorkspace().rootPath, "reviewer", {
    harness: "codex",
    model: "smart",
    instructions: "Review the request.",
  });
  const first = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "establish context",
  });
  runtime.handleUserMessage(first.message);
  await runtime.settled(first.thread.id);

  const second = store.appendMessage(first.thread.id, {
    author: "user",
    kind: "message",
    content: "@reviewer inspect the context",
  });
  runtime.handleUserMessage(second);
  await runtime.settled(first.thread.id);

  const reply = store.listMessages(first.thread.id).at(-1)!;
  expect(reply.metadata.agent).toBe("reviewer");
  // The routing mention is stripped from the prompt; the durable log row
  // (asserted below) keeps the original text.
  expect(reply.content).toBe(
    "[model=smart] [intro] [catchup] echo#1: inspect the context",
  );
  expect(store.getThreadSession(first.thread.id, "default")).not.toBeNull();
  expect(store.getThreadSession(first.thread.id, "reviewer")).toMatchObject({
    agentName: "reviewer",
    lastSeenSeq: reply.seq,
  });
  expect(second.metadata).toEqual({
    mentions: ["reviewer"],
    routedTo: ["reviewer"],
  });
  await done();
});

test("unmentioned replies stay with the agent that started the thread", async () => {
  const { store, runtime, channel, done } = await fixture();
  await writeAgent(store.defaultWorkspace().rootPath, "reviewer", {
    harness: "codex",
    model: "smart",
    instructions: "Review the request.",
  });
  const root = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "@reviewer own this thread",
    metadata: { mentions: ["reviewer"], routedTo: ["reviewer"] },
  });
  runtime.handleUserMessage(root.message, ["reviewer"]);
  await runtime.settled(root.thread.id);

  const reply = store.appendMessage(root.thread.id, {
    author: "user",
    kind: "message",
    content: "now keep going",
  });
  runtime.handleUserMessage(reply);
  await runtime.settled(root.thread.id);

  const answer = store.listMessages(root.thread.id).at(-1)!;
  expect(answer.metadata.agent).toBe("reviewer");
  expect(answer.content).toBe("[model=smart] echo#2: now keep going");
  expect(reply.metadata).toEqual({ mentions: [], routedTo: ["reviewer"] });
  // The workspace default was never pulled into the thread.
  expect(store.getThreadSession(root.thread.id, "default")).toBeNull();
  await done();
});

test("agent messages reach peers verbatim", async () => {
  const { store, runtime, channel, done } = await fixture();
  await writeAgent(store.defaultWorkspace().rootPath, "reviewer", {
    harness: "codex",
    model: "smart",
    instructions: "Review the request.",
  });
  const root = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "start",
  });
  runtime.handleUserMessage(root.message);
  await runtime.settled(root.thread.id);

  // Only `to` routed this; the possessive is the sender's own words.
  const handoff = store.appendMessage(root.thread.id, {
    author: "agent",
    kind: "message",
    content: "@reviewer’s pass is clean",
    metadata: { agent: "default" },
  });
  runtime.handleAgentMessage(handoff, ["reviewer"]);
  await runtime.settled(root.thread.id);

  const reply = store.listMessages(root.thread.id).at(-1)!;
  expect(reply.metadata.agent).toBe("reviewer");
  expect(reply.content).toBe(
    "[model=smart] [intro] [catchup] echo#1: @reviewer’s pass is clean",
  );
  await done();
});

test("a mid-body mention wakes the agent speculatively and silence is legal", async () => {
  const { store, runtime, channel, done } = await fixture();
  await writeAgent(store.defaultWorkspace().rootPath, "reviewer", {
    harness: "codex",
    instructions: "Review the request.",
  });
  const root = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "hello, loop in @reviewer if needed",
  });
  runtime.handleUserMessage(root.message);
  await runtime.settled(root.thread.id);

  // The primary replied; the speculative agent's stray turn text was
  // discarded without an "ended the turn without a reply" error.
  const messages = store.listMessages(root.thread.id);
  const agentMessages = messages.filter((m) => m.author === "agent");
  expect(agentMessages).toHaveLength(1);
  expect(agentMessages[0]!.metadata.agent).toBe("default");
  expect(messages.filter((m) => m.kind === "error")).toHaveLength(0);
  expect(root.message.metadata).toMatchObject({
    mentions: ["reviewer"],
    routedTo: ["default", "reviewer"],
    speculative: ["reviewer"],
  });
  // The speculative agent joined the thread: its session binding exists and
  // its catch-up cursor advanced past what it was shown.
  expect(store.getThreadSession(root.thread.id, "reviewer")).not.toBeNull();
  await done();
});

test("a speculative agent that contributes replies through send_message", async () => {
  const { store, runtime, channel, done } = await fixture({
    agentArgs: ["tool"],
  });
  await writeAgent(store.defaultWorkspace().rootPath, "reviewer", {
    harness: "codex",
    instructions: "Review the request.",
  });
  // Pre-routed like serve.ts: metadata carries the speculative split.
  const content = "plan this out and get @reviewer input";
  const routing = await runtime.routeUserContent(content);
  const root = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content,
    metadata: { ...routing },
  });
  runtime.handleUserMessage(root.message, routing.routedTo);
  await runtime.settled(root.thread.id);

  const agentMessages = store
    .listMessages(root.thread.id)
    .filter((m) => m.author === "agent");
  expect(agentMessages.map((m) => m.metadata.agent)).toEqual([
    "default",
    "reviewer",
  ]);
  // Only the speculative turn carried the stay-silent note, and its prompt
  // included the primary's reply as since-then context.
  expect(agentMessages[0]!.content).toBe(`tool#1: ${content}`);
  expect(agentMessages[1]!.content).toBe(`[since] [nudge] tool#1: ${content}`);
  await done();
});

test("the hop budget pauses further agent-triggered turns until a user message", async () => {
  const { store, runtime, channel, done } = await fixture({ hopBudget: 4 });
  await writeAgent(store.defaultWorkspace().rootPath, "reviewer", {
    harness: "codex",
    instructions: "Review the request.",
  });
  const root = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "start",
  });
  runtime.handleUserMessage(root.message);
  await runtime.settled(root.thread.id);

  for (let index = 1; index <= 5; index += 1) {
    const handoff = store.appendMessage(root.thread.id, {
      author: "agent",
      kind: "message",
      content: `handoff ${index}`,
      metadata: { agent: "default" },
    });
    runtime.handleAgentMessage(handoff, ["reviewer"]);
    await runtime.settled(root.thread.id);
  }

  const messages = store.listMessages(root.thread.id);
  expect(
    messages.filter(
      (message) =>
        message.author === "agent" && message.metadata.agent === "reviewer",
    ),
  ).toHaveLength(4);
  const pause = messages.at(-1)!;
  expect(pause).toMatchObject({
    author: "system",
    metadata: { reason: "agent-hop-budget", routedTo: ["reviewer"] },
  });
  expect(pause.content).toContain("paused after 4 hops");

  const continuation = store.appendMessage(root.thread.id, {
    author: "user",
    kind: "message",
    content: "@reviewer continue",
  });
  runtime.handleUserMessage(continuation);
  await runtime.settled(root.thread.id);
  expect(
    store
      .listMessages(root.thread.id)
      .filter(
        (message) =>
          message.author === "agent" && message.metadata.agent === "reviewer",
      ),
  ).toHaveLength(5);
  await done();
});

test("a budget-tripped multi-recipient handoff names every dropped recipient", async () => {
  const { store, runtime, channel, done } = await fixture({ hopBudget: 0 });
  for (const name of ["reviewer", "implementer"]) {
    await writeAgent(store.defaultWorkspace().rootPath, name, {
      harness: "codex",
      instructions: `Act as the ${name}.`,
    });
  }
  const root = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "start",
  });
  const handoff = store.appendMessage(root.thread.id, {
    author: "agent",
    kind: "message",
    content: "over to you both",
    metadata: { agent: "default" },
  });

  runtime.handleAgentMessage(handoff, ["reviewer", "implementer"]);
  await runtime.settled(root.thread.id);

  const pause = store.listMessages(root.thread.id).at(-1)!;
  expect(pause).toMatchObject({
    author: "system",
    metadata: {
      reason: "agent-hop-budget",
      routedTo: ["reviewer", "implementer"],
    },
  });
  expect(pause.content).toContain("@reviewer, @implementer were next");
  await done();
});

test("multiple handoff recipients take serialized turns in list order", async () => {
  const { store, runtime, channel, done } = await fixture();
  for (const name of ["reviewer", "implementer"]) {
    await writeAgent(store.defaultWorkspace().rootPath, name, {
      harness: "codex",
      instructions: `Act as the ${name}.`,
    });
  }
  const root = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "shared brief",
  });
  const handoff = store.appendMessage(root.thread.id, {
    author: "agent",
    kind: "message",
    content: "take your turns",
    metadata: { agent: "default" },
  });

  runtime.handleAgentMessage(handoff, ["reviewer", "implementer"]);
  await runtime.settled(root.thread.id);

  expect(
    store
      .listMessages(root.thread.id)
      .filter(
        (message) =>
          message.author === "agent" &&
          ["reviewer", "implementer"].includes(String(message.metadata.agent)),
      )
      .map((message) => message.metadata.agent),
  ).toEqual(["reviewer", "implementer"]);
  expect(store.getThread(root.thread.id)!.turnActive).toBe(false);
  await done();
});

test("the start barrier queues new turns and restore ignores pending work", async () => {
  const { store, runtime, channel, checkpoints, done } = await fixture({
    withCheckpoints: true,
  });
  const workspace = store.defaultWorkspace();
  mkdirSync(join(workspace.rootPath, "channels"), { recursive: true });
  const baseline = store.latestCheckpoint(workspace.id)!;

  let enteredExclusive!: () => void;
  const exclusiveStarted = new Promise<void>((resolve) => {
    enteredExclusive = resolve;
  });
  let releaseExclusive!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseExclusive = resolve;
  });

  const exclusive = runtime.withIdleExclusive(async () => {
    enteredExclusive();
    await hold;
    return checkpoints!.restore({
      checkpointId: baseline.id,
      scope: "scratch",
    });
  });
  await exclusiveStarted;

  const first = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "wait behind restore",
  });
  runtime.handleUserMessage(first.message);

  const second = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "also queued",
  });
  runtime.handleUserMessage(second.message);

  await Bun.sleep(50);
  expect(
    store
      .listMessages(first.thread.id)
      .filter((item) => item.author === "agent"),
  ).toHaveLength(0);
  expect(
    store
      .listMessages(second.thread.id)
      .filter((item) => item.author === "agent"),
  ).toHaveLength(0);

  releaseExclusive();
  const restored = await exclusive;
  expect(restored.noop).toBe(true);

  await Promise.all([
    runtime.settled(first.thread.id),
    runtime.settled(second.thread.id),
  ]);
  expect(
    store
      .listMessages(first.thread.id)
      .filter((item) => item.author === "agent"),
  ).toHaveLength(1);
  expect(
    store
      .listMessages(second.thread.id)
      .filter((item) => item.author === "agent"),
  ).toHaveLength(1);
  await done();
});

test("restore is busy only for a live turn, not queued-behind-barrier work", async () => {
  const { store, runtime, channel, checkpoints, done } = await fixture({
    agentArgs: ["slow"],
    withCheckpoints: true,
  });
  const workspace = store.defaultWorkspace();
  const baseline = store.latestCheckpoint(workspace.id)!;

  const live = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "hang",
  });
  runtime.handleUserMessage(live.message);
  await Bun.sleep(100);
  expect(runtime.hasActiveWork()).toBe(true);
  try {
    await runtime.withIdleExclusive(() =>
      checkpoints!.restore({ checkpointId: baseline.id, scope: "scratch" }),
    );
    throw new Error("expected busy");
  } catch (error) {
    expect(error).toBeInstanceOf(CheckpointBusyError);
  }
  expect(runtime.cancelTurn(live.thread.id)).toBe(true);
  await runtime.settled(live.thread.id);

  let enteredExclusive!: () => void;
  const exclusiveStarted = new Promise<void>((resolve) => {
    enteredExclusive = resolve;
  });
  let releaseExclusive!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseExclusive = resolve;
  });
  const exclusive = runtime.withIdleExclusive(async () => {
    enteredExclusive();
    await hold;
    return checkpoints!.restore({
      checkpointId: baseline.id,
      scope: "scratch",
    });
  });
  await exclusiveStarted;

  const queued = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "behind the barrier",
  });
  runtime.handleUserMessage(queued.message);
  await Bun.sleep(30);
  releaseExclusive();
  await expect(exclusive).resolves.toMatchObject({ noop: true });
  expect(runtime.cancelTurn(queued.thread.id)).toBe(true);
  await runtime.settled(queued.thread.id);
  await done();
});

test("shutdown with an active and queued turn does not deadlock", async () => {
  const { store, runtime, channel, checkpoints, done } = await fixture({
    agentArgs: ["slow"],
    withCheckpoints: true,
  });
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "active",
  });
  runtime.handleUserMessage(message);
  await Bun.sleep(100);
  runtime.handleUserMessage(
    store.appendMessage(thread.id, {
      author: "user",
      kind: "message",
      content: "queued",
    }),
  );
  writeFileSync(
    join(store.defaultWorkspace().rootPath, "channels", "shutdown.md"),
    "bye\n",
  );
  await runtime.shutdown();
  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  const rows = store.listCheckpoints(store.defaultWorkspace().id);
  expect(rows.some((row) => row.trigger === "shutdown")).toBe(true);
  expect(checkpoints!.health().status).toBe("ok");
  await done();
});

test("two overlapping turns capture once at global idle", async () => {
  const { store, runtime, channel, checkpoints, done } = await fixture({
    agentArgs: ["slow"],
    withCheckpoints: true,
  });
  const workspace = store.defaultWorkspace();
  const before = store.listCheckpoints(workspace.id).length;
  mkdirSync(join(workspace.rootPath, "channels"), { recursive: true });
  writeFileSync(join(workspace.rootPath, "channels", "overlap.md"), "both\n");

  const a = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "one",
  });
  const b = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "two",
  });
  runtime.handleUserMessage(a.message);
  runtime.handleUserMessage(b.message);
  await Bun.sleep(100);
  expect(store.getThread(a.thread.id)!.turnActive).toBe(true);
  expect(store.getThread(b.thread.id)!.turnActive).toBe(true);

  expect(runtime.cancelTurn(a.thread.id)).toBe(true);
  expect(runtime.cancelTurn(b.thread.id)).toBe(true);
  await Promise.all([
    runtime.settled(a.thread.id),
    runtime.settled(b.thread.id),
  ]);
  await checkpoints!.flush();
  const turnRows = store
    .listCheckpoints(workspace.id)
    .filter((row) => row.trigger === "turn");
  expect(store.listCheckpoints(workspace.id).length).toBe(before + 1);
  expect(turnRows).toHaveLength(1);
  await done();
});

test("untagged replies route to the last agent that answered", async () => {
  const { store, runtime, channel, done } = await fixture();
  await writeAgent(store.defaultWorkspace().rootPath, "reviewer", {
    harness: "codex",
    instructions: "Review the request.",
  });
  const root = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "hello",
    metadata: { mentions: [], routedTo: ["default"] },
  });

  // Before any agent reply, the thread still belongs to the root's agent.
  expect(await runtime.routeUserContent("keep going", root.thread.id)).toEqual({
    mentions: [],
    routedTo: ["default"],
  });

  store.appendMessage(root.thread.id, {
    author: "agent",
    kind: "message",
    content: "done — handing to review",
    metadata: { agent: "default" },
  });
  store.appendMessage(root.thread.id, {
    author: "agent",
    kind: "message",
    content: "review notes",
    metadata: { agent: "reviewer" },
  });
  expect(
    await runtime.routeUserContent("thanks, one more thing", root.thread.id),
  ).toEqual({
    mentions: [],
    routedTo: ["reviewer"],
  });

  // A mention still outranks the last responder.
  expect(
    await runtime.routeUserContent("@default take over", root.thread.id),
  ).toEqual({
    mentions: ["default"],
    routedTo: ["default"],
  });

  // A last responder that has since been deleted degrades to the
  // workspace default.
  store.appendMessage(root.thread.id, {
    author: "agent",
    kind: "message",
    content: "gone now",
    metadata: { agent: "ghost" },
  });
  expect(await runtime.routeUserContent("still there?", root.thread.id)).toEqual(
    {
      mentions: [],
      routedTo: ["default"],
    },
  );
  await done();
});
