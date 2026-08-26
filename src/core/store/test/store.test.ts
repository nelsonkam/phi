import { test, expect } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@/testing/tmpdir";
import { PhiStore } from "../store";

test("migrates a fresh database and seeds defaults", () => {
  const root = tempDir();
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  expect(workspace.name).toBe("default");
  expect(workspace.rootPath).toBe(join(root, "workspace"));

  const channels = store.listChannels(workspace.id);
  expect(channels.map((c) => c.name)).toEqual(["general"]);
  store.close();
});

function chatFixture() {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  return { store, channel };
}

test("createThread writes the thread and its first message atomically", () => {
  const { store, channel } = chatFixture();
  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Ship the chat slice\nwith details below",
  });

  expect(thread.title).toBe("Ship the chat slice");
  expect(thread.status).toBe("open");
  expect(thread.lastSeq).toBe(1);
  expect(message.seq).toBe(1);
  expect(message.threadId).toBe(thread.id);
  expect(store.listMessages(thread.id)).toHaveLength(1);
  store.close();
});

test("appendMessage allocates monotonic seqs and bumps the thread", () => {
  const { store, channel } = chatFixture();
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "First",
  });
  const second = store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "Second",
  });
  const other = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Other thread",
  });

  expect(second.seq).toBe(2);
  // Seq is per-workspace, so the next thread's first message continues it.
  expect(other.message.seq).toBe(3);
  expect(store.getThread(thread.id)!.lastSeq).toBe(2);
  store.close();
});

test("persists and emits explicit turn presence", () => {
  const { store, channel } = chatFixture();
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Work on this",
  });
  const turns: Array<{ active: boolean; agent: string | null }> = [];
  store.onChange = (change) => {
    if (change.type === "thread.turn") {
      turns.push({ active: change.active, agent: change.agent });
    }
  };

  store.setThreadTurn(thread.id, true, "default");
  expect(store.getThread(thread.id)).toMatchObject({
    turnActive: true,
    turnAgent: "default",
  });
  expect(store.listActiveTurns(thread.workspaceId)).toEqual([
    { threadId: thread.id, active: true, agent: "default" },
  ]);

  store.setThreadTurn(thread.id, false, null);
  expect(store.getThread(thread.id)).toMatchObject({
    turnActive: false,
    turnAgent: null,
  });
  expect(turns).toEqual([
    { active: true, agent: "default" },
    { active: false, agent: null },
  ]);
  store.close();
});

test("persists and replaces a thread's harness session binding", () => {
  const root = tempDir();
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Keep this context",
  });

  const first = store.saveThreadSession({
    threadId: thread.id,
    harnessId: "codex",
    agentName: "default",
    sessionId: "session-one",
    model: "smart",
    config: { effort: "high", fast: true },
  });
  expect(store.getThreadSession(thread.id)).toEqual(first);

  const replacement = store.saveThreadSession({
    ...first,
    sessionId: "session-two",
    model: null,
    config: {},
  });
  expect(replacement.createdAt).toBe(first.createdAt);
  expect(replacement.sessionId).toBe("session-two");
  store.close();

  const reopened = new PhiStore(root);
  expect(reopened.getThreadSession(thread.id)).toMatchObject({
    harnessId: "codex",
    agentName: "default",
    sessionId: "session-two",
    model: null,
    config: {},
  });
  reopened.close();
});

test("listThreads orders by activity and counts messages", () => {
  const { store, channel } = chatFixture();
  const a = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "A",
  });
  const b = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "B",
  });
  store.appendMessage(a.thread.id, {
    author: "user",
    kind: "message",
    content: "reply",
  });

  const threads = store.listThreads(channel.id);
  expect(threads.map((t) => t.title)).toEqual(["A", "B"]);
  expect(threads[0]!.messageCount).toBe(2);
  expect(threads[1]!.messageCount).toBe(1);
  store.close();
});

test("writes emit post-commit changes", () => {
  const { store, channel } = chatFixture();
  const changes: string[] = [];
  store.onChange = (change) => changes.push(change.type);

  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Hello",
  });
  store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "Again",
  });

  expect(changes).toEqual([
    "thread.updated",
    "message.appended",
    "message.appended",
    "thread.updated",
  ]);
  store.close();
});

test("migrations are idempotent across reopen", () => {
  const root = tempDir();
  new PhiStore(root).close();
  const reopened = new PhiStore(root);
  expect(reopened.listChannels(reopened.defaultWorkspace().id)).toHaveLength(1);
  reopened.close();
});

test("default workspace root follows a moved phi root", () => {
  const oldRoot = tempDir();
  const newRoot = tempDir();
  new PhiStore(oldRoot).close();

  copyFileSync(join(oldRoot, "phi.db"), join(newRoot, "phi.db"));
  const moved = new PhiStore(newRoot);
  expect(moved.defaultWorkspace().rootPath).toBe(join(newRoot, "workspace"));
  moved.close();
});
