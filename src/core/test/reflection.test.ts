import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  REFLECTION_CHANNEL_NAME,
  REFLECTION_PROMPT,
  ReflectionService,
} from "@/core/reflection";
import { PhiStore } from "@/core/store/store";
import type { Message } from "@/shared/types";
import { tempDir } from "@/testing/tmpdir";

test("scheduled reflection creates one skill-driven thread", async () => {
  const store = new PhiStore(tempDir());
  const dispatched: Array<{ message: Message; routedTo: string[] }> = [];
  const service = new ReflectionService(store, {
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
  });

  expect(await service.runOnce()).toBe(1);
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]!.routedTo).toEqual(["default"]);
  expect(dispatched[0]!.message.kind).toBe("reflection");
  expect(dispatched[0]!.message.content).toBe(REFLECTION_PROMPT);
  expect(dispatched[0]!.message.metadata).toMatchObject({
    reflection: true,
    routedTo: ["default"],
  });

  const reflectionChannel = store
    .listChannels(store.defaultWorkspace().id)
    .find((item) => item.name === REFLECTION_CHANNEL_NAME)!;
  expect(
    store
      .listThreads(reflectionChannel.id)
      .filter((item) => item.rootMessage?.kind === "reflection"),
  ).toHaveLength(1);
  store.close();
});

test("failed reflection throws so the scheduler can retry", async () => {
  const store = new PhiStore(tempDir());
  const service = new ReflectionService(store, {
    handleSystemMessage() {},
    settled: async () => undefined,
  });

  await expect(service.runOnce()).rejects.toThrow(
    "ended without an agent reply",
  );
  const reflectionChannel = store
    .listChannels(store.defaultWorkspace().id)
    .find((item) => item.name === REFLECTION_CHANNEL_NAME)!;
  expect(
    store
      .listThreads(reflectionChannel.id)
      .filter((thread) => thread.rootMessage?.kind === "reflection"),
  ).toHaveLength(1);
  store.close();
});

test("reflection checkpoints store one cursor per channel", () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Remember this",
  });
  store.appendMessage(thread.id, {
    author: "agent",
    kind: "message",
    content: "I will.",
    metadata: { agent: "codex" },
  });

  expect(store.getReflectionCheckpoint(channel.id)).toBe(0);
  expect(store.listReflectionCheckpoints(workspace.id)).toEqual([
    {
      channelId: channel.id,
      channelName: channel.name,
      throughSeq: 0,
    },
  ]);
  store.setReflectionCheckpoint(channel.id, 2);
  expect(store.getReflectionCheckpoint(channel.id)).toBe(2);
  expect(store.setReflectionCheckpoint(channel.id, 1)).toBe(2);
  expect(store.getReflectionCheckpoint(channel.id)).toBe(2);
  expect(() => store.setReflectionCheckpoint(channel.id, 3)).toThrow(
    "past channel last seq 2",
  );
  store.close();
});

test("a stale checkpoint write cannot rewind a newer cursor", () => {
  const store = new PhiStore(tempDir());
  const channel = store.listChannels(store.defaultWorkspace().id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "one",
  });
  store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "two",
  });
  store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "three",
  });

  expect(store.setReflectionCheckpoint(channel.id, 2)).toBe(2);
  expect(store.setReflectionCheckpoint(channel.id, 3)).toBe(3);
  expect(store.setReflectionCheckpoint(channel.id, 1)).toBe(3);
  expect(store.getReflectionCheckpoint(channel.id)).toBe(3);
  store.close();
});

test("channel thread summaries include ordinary and reflection threads", () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Real user signal",
  });
  store.createThread(channel.id, {
    author: "agent",
    kind: "message",
    content: "Change a channel skill",
    metadata: { agent: "codex" },
  });
  const reflectionChannel = store.createChannel(workspace.id, {
    name: "reflection",
  });
  const run = store.createThread(reflectionChannel.id, {
    author: "system",
    kind: "reflection",
    content: "Run the reflect skill.",
    metadata: { reflection: true },
  });

  const source = store.channelThreadSummaries(channel.id, 1, 100);
  expect(
    source.map((thread) => thread.firstMessage.content),
  ).toEqual(["Real user signal", "Change a channel skill"]);
  expect(
    store
      .channelThreadSummaries(reflectionChannel.id, 1, 100)
      .map((thread) => thread.threadId),
  ).toEqual([run.thread.id]);
  store.close();
});

test("019 copies the highest reflection_runs cursor per channel", () => {
  const root = tempDir();
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "legacy",
  });
  const later = store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "later",
  });
  const other = store.createChannel(workspace.id, { name: "other" });
  const { thread: otherThread } = store.createThread(other.id, {
    author: "user",
    kind: "message",
    content: "other",
  });
  store.close();

  const db = new Database(join(root, "phi.db"));
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
    CREATE TABLE reflection_runs (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      through_seq INTEGER NOT NULL,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      UNIQUE (channel_id, through_seq)
    );
  `);
  db.query(
    `INSERT INTO reflection_runs
       (id, channel_id, through_seq, thread_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "reflection_low",
    channel.id,
    1,
    thread.id,
    "2026-01-01T00:00:00.000Z",
  );
  db.query(
    `INSERT INTO reflection_runs
       (id, channel_id, through_seq, thread_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "reflection_high",
    channel.id,
    later.seq,
    thread.id,
    "2026-01-02T00:00:00.000Z",
  );
  db.query(
    `INSERT INTO reflection_runs
       (id, channel_id, through_seq, thread_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "reflection_other",
    other.id,
    otherThread.lastSeq,
    otherThread.id,
    "2026-01-03T00:00:00.000Z",
  );
  db.run("DROP TABLE channel_checkpoints");
  db.query("DELETE FROM schema_migrations WHERE id = ?").run(
    "019_channel_checkpoints",
  );
  db.close();

  const migrated = new PhiStore(root);
  expect(migrated.getReflectionCheckpoint(channel.id)).toBe(later.seq);
  expect(migrated.getReflectionCheckpoint(other.id)).toBe(otherThread.lastSeq);
  expect(
    migrated.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'reflection_runs'",
      )
      .get()?.n,
  ).toBe(0);
  migrated.close();
});
