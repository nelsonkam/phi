import { test, expect } from "bun:test";
import { join } from "node:path";
import { tempDir } from "@/testing/tmpdir";
import { PhiStore } from "@/core/store/store";
import { ensureWorkspace } from "@/core/workspace";
import { writeDefaultAgent } from "@/core/agents/registry";
import { AgentRuntime } from "@/core/agents/runtime";
import type { Channel } from "@/shared/types";

const FAKE_AGENT = join(import.meta.dir, "fixtures", "fake-acp-agent.ts");

interface Fixture {
  store: PhiStore;
  runtime: AgentRuntime;
  channel: Channel;
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
  const runtime = new AgentRuntime(store, workspace.rootPath, {
    resolveCommand: () => [
      process.execPath,
      FAKE_AGENT,
      ...(options?.agentArgs ?? []),
    ],
  });
  const channel = store.listChannels(workspace.id)[0]!;
  const done = () => {
    runtime.close();
    store.close();
  };
  return { store, runtime, channel, done };
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
  // model config option before the prompt.
  expect(reply.content).toBe("[model=smart] echo#1: hello agent");
  expect(reply.metadata).toEqual({ agent: "default", stopReason: "end_turn" });
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
  // The fake's turn counter is per process, so "#2" proves session reuse.
  expect(replies).toEqual([
    "[model=smart] echo#1: first",
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
    "[model=smart] echo#1: thread one",
  );
  expect(store.listMessages(second.thread.id)[1]!.content).toBe(
    "[model=smart] echo#1: thread two",
  );
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
