import { expect, test } from "bun:test";
import {
  REFLECTION_CHANNEL_NAME,
  ReflectionService,
  reflectionPrompt,
} from "@/core/reflection";
import { PhiStore } from "@/core/store/store";
import type { Message } from "@/shared/types";
import { tempDir } from "@/testing/tmpdir";

test("scheduled reflection creates one auditable thread and advances its cursor", async () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Please keep reports concise.",
  });
  store.appendMessage(thread.id, {
    author: "agent",
    kind: "message",
    content: "I will.",
    metadata: { agent: "codex" },
  });
  store.setThreadOutcome(thread.id, "worked");

  const dispatched: Array<{ message: Message; routedTo: string[] }> = [];
  const service = new ReflectionService(
    store,
    {
      handleSystemMessage(message, routedTo) {
        dispatched.push({ message, routedTo });
        store.appendMessage(message.threadId, {
          author: "agent",
          kind: "message",
          content: "Reflection complete.",
          metadata: { agent: "codex" },
        });
      },
      settled: async () => undefined,
    },
    { minMessages: 2, messageLimit: 20 },
  );

  expect(await service.runOnce()).toBe(1);
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]!.routedTo).toEqual(["default"]);
  expect(dispatched[0]!.message.kind).toBe("reflection");
  expect(dispatched[0]!.message.content).not.toContain("Please keep reports concise.");
  expect(dispatched[0]!.message.content).toContain("list_channel_threads");
  expect(dispatched[0]!.message.content).toContain("read_thread");
  expect(dispatched[0]!.message.content).toContain("Never edit AGENTS.md");
  expect(dispatched[0]!.message.metadata).toMatchObject({
    reflection: true,
    sourceChannelId: channel.id,
    sourceChannelName: channel.name,
    fromSeq: 1,
    throughSeq: 2,
  });
  expect(await service.runOnce()).toBe(0);

  expect(
    store
      .listThreads(channel.id)
      .filter((item) => item.rootMessage?.kind === "reflection"),
  ).toHaveLength(0);
  const reflectionChannel = store
    .listChannels(workspace.id)
    .find((item) => item.name === REFLECTION_CHANNEL_NAME)!;
  expect(
    store
      .listThreads(reflectionChannel.id)
      .filter((item) => item.rootMessage?.kind === "reflection"),
  ).toHaveLength(1);
  store.close();
});

test("failed reflection keeps its window eligible for retry", async () => {
  const store = new PhiStore(tempDir());
  const channel = store.listChannels(store.defaultWorkspace().id)[0]!;
  store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Remember this",
  });
  const service = new ReflectionService(
    store,
    {
      handleSystemMessage() {},
      settled: async () => undefined,
    },
    { minMessages: 1 },
  );

  await expect(service.runOnce()).rejects.toThrow("ended without an agent reply");
  expect(
    store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM reflection_runs").get()
      ?.n,
  ).toBe(0);
  await expect(service.runOnce()).rejects.toThrow("ended without an agent reply");
  const reflectionChannel = store
    .listChannels(store.defaultWorkspace().id)
    .find((item) => item.name === REFLECTION_CHANNEL_NAME)!;
  expect(
    store
      .listThreads(reflectionChannel.id)
      .filter((thread) => thread.rootMessage?.kind === "reflection"),
  ).toHaveLength(2);
  store.close();
});

test("busy channels reflect oldest-first without skipping capped history", async () => {
  const store = new PhiStore(tempDir());
  const channel = store.listChannels(store.defaultWorkspace().id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "message one",
  });
  for (const content of ["message two", "message three", "message four"]) {
    store.appendMessage(thread.id, { author: "user", kind: "message", content });
  }
  const windows: Array<{ fromSeq: unknown; throughSeq: unknown }> = [];
  const service = new ReflectionService(
    store,
    {
      handleSystemMessage(message) {
        windows.push({
          fromSeq: message.metadata.fromSeq,
          throughSeq: message.metadata.throughSeq,
        });
        store.appendMessage(message.threadId, {
          author: "agent",
          kind: "message",
          content: "Reflection complete.",
          metadata: { agent: "codex" },
        });
      },
      settled: async () => undefined,
    },
    { minMessages: 2, messageLimit: 2 },
  );

  expect(await service.runOnce()).toBe(1);
  expect(windows[0]).toEqual({ fromSeq: 1, throughSeq: 2 });
  expect(await service.runOnce()).toBe(1);
  expect(windows[1]).toEqual({ fromSeq: 3, throughSeq: 4 });
  store.close();
});

test("review proposal threads do not feed later reflection passes", () => {
  const store = new PhiStore(tempDir());
  const channel = store.listChannels(store.defaultWorkspace().id)[0]!;
  store.createThread(channel.id, {
    author: "agent",
    kind: "message",
    content: "<!-- phi:reflection-proposal -->\nChange a channel skill",
    metadata: { agent: "codex" },
  });
  store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Real user signal",
  });

  const window = store.reflectionWindow(channel.id, {
    minMessages: 1,
    limit: 20,
  });
  expect(window).toMatchObject({ messageCount: 1 });
  const threads = store.channelThreadSummaries(
    channel.id,
    window!.fromSeq,
    window!.throughSeq,
  );
  expect(threads.map((thread: { firstMessage: { content: string } }) => thread.firstMessage.content)).toEqual([
    "Real user signal",
  ]);
  store.close();
});

test("reflection prompt routes facts and procedures through different lanes", () => {
  const prompt = reflectionPrompt("product", {
    fromSeq: 3,
    throughSeq: 4,
    messageCount: 2,
  });
  expect(prompt).toContain("frozen 2-message window 3–4");
  expect(prompt).toContain("list_channel_threads");
  expect(prompt).toContain("read_thread");
  expect(prompt).toContain("channels/product/rules.md");
  expect(prompt).toContain("workspace-wide user rules/preferences in rules.md");
  expect(prompt).toContain("channels/product/skills/");
  expect(prompt).toContain("#meta");
  expect(prompt).toContain("small delta edits");
  expect(prompt).toContain("<!-- phi:reflection-proposal -->");
  expect(prompt).toContain("remove stale index entries");
  expect(prompt).toContain("never delete or rewrite user-authored memory");
});
