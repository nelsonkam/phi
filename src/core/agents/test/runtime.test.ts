import { test, expect } from "bun:test";
import { join } from "node:path";
import { tempDir } from "@/testing/tmpdir";
import { PhiStore } from "@/core/store/store";
import { ensureWorkspace } from "@/core/workspace";
import { writeDefaultAgent } from "@/core/agents/registry";
import { AgentRuntime } from "@/core/agents/runtime";
import { createMcpHandler } from "@/server/mcp";
import { McpTokenRegistry } from "@/server/mcp-token-registry";
import type { Channel } from "@/shared/types";

const FAKE_AGENT = join(import.meta.dir, "fixtures", "fake-acp-agent.ts");

interface Fixture {
  store: PhiStore;
  runtime: AgentRuntime;
  channel: Channel;
  mcpPort: number;
  mcpTokens: McpTokenRegistry;
  done: () => void;
}

async function fixture(options?: {
  agent?: false;
  agentArgs?: string[];
}): Promise<Fixture> {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  ensureWorkspace(workspace.rootPath);
  if (options?.agent !== false) {
    await writeDefaultAgent(workspace.rootPath, {
      harness: "claude-code",
      model: "smart",
    });
  }
  const mcpTokens = new McpTokenRegistry();
  const mcpHandler = createMcpHandler(store, mcpTokens);
  const mcpServer = Bun.serve({
    port: 0,
    fetch: (req) => mcpHandler(req),
  });
  const runtime = new AgentRuntime(store, workspace.rootPath, {
    mcpPort: mcpServer.port!,
    mcpTokens,
    resolveCommand: () => [
      process.execPath,
      FAKE_AGENT,
      ...(options?.agentArgs ?? []),
    ],
  });
  const channel = store.listChannels(workspace.id)[0]!;
  const done = () => {
    runtime.close();
    void mcpServer.stop(true);
    store.close();
  };
  return {
    store,
    runtime,
    channel,
    mcpPort: mcpServer.port!,
    mcpTokens,
    done,
  };
}

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
  expect(reply.author).toBe("coordinator");
  // "[model=smart]" proves the agent's saved model reached the session's
  // model config option before the prompt; "[intro]" proves the fresh
  // session's first prompt carried the messaging preamble.
  expect(reply.content).toBe("[model=smart] [intro] echo#1: hello agent");
  expect(reply.metadata).toEqual({
    agent: "default",
    stopReason: "end_turn",
    via: "turn-text-fallback",
  });
  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  done();
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
      change.message.author === "coordinator"
    ) {
      activeWhenDelivered = store.getThread(thread.id)!.turnActive;
    }
  };

  runtime.handleUserMessage(message);
  await runtime.settled(thread.id);

  const replies = store
    .listMessages(thread.id)
    .filter((item) => item.author === "coordinator");
  expect(replies).toHaveLength(1);
  expect(replies[0]!.content).toBe("tool#1: do the work");
  expect(replies[0]!.metadata).toEqual({ agent: "default" });
  expect(activeWhenDelivered).toBe(true);
  expect(store.getThread(thread.id)!.turnActive).toBe(false);
  done();
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
  done();
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
  done();
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
  done();
});

test("turns in one thread serialize and reuse one session", async () => {
  const { store, runtime, channel, done } = await fixture();
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
  await runtime.settled(thread.id);

  const replies = store
    .listMessages(thread.id)
    .filter((m) => m.author === "coordinator")
    .map((m) => m.content);
  // The fake's turn counter is per process, so "#2" proves session reuse,
  // and the missing "[intro]" proves the preamble is sent only once per
  // session.
  expect(replies).toEqual([
    "[model=smart] [intro] echo#1: first",
    "[model=smart] echo#2: second",
  ]);
  done();
});

test("threads get separate sessions", async () => {
  const { store, runtime, channel, done } = await fixture();
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

  // Both threads see turn #1: each got its own fake agent process.
  expect(store.listMessages(first.thread.id)[1]!.content).toBe(
    "[model=smart] [intro] echo#1: thread one",
  );
  expect(store.listMessages(second.thread.id)[1]!.content).toBe(
    "[model=smart] [intro] echo#1: thread two",
  );
  done();
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
  resumedRuntime.close();
  done();
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
  runtime.close();

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
      .filter((message) => message.author === "coordinator")
      .map((message) => message.content),
  ).toEqual([
    "[model=smart] [intro] echo#1: first",
    // No "[intro]" after session/load: the restored history has the preamble.
    "[model=smart] echo#2: second",
  ]);
  loadedRuntime.close();
  done();
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
  runtime.close();

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
    "[model=smart] [intro] echo#1: second",
  );
  replacementRuntime.close();
  done();
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
  runtime.close();

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
    "[model=smart] [intro] echo#1: second",
  );
  replacementRuntime.close();
  done();
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
  done();
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
  done();
});
