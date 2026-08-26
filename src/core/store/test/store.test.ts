import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@/testing/tmpdir";
import { PhiStore } from "../store";
import m001 from "@/db/migrations/001_init.sql" with { type: "text" };
import m002 from "@/db/migrations/002_thread_turn_state.sql" with { type: "text" };
import m003 from "@/db/migrations/003_thread_sessions.sql" with { type: "text" };
import m004 from "@/db/migrations/004_message_search.sql" with { type: "text" };

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
    lastSeenSeq: 1,
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
  const reviewer = store.saveThreadSession({
    threadId: thread.id,
    harnessId: "claude-code",
    agentName: "reviewer",
    sessionId: "review-session",
    model: "careful",
    config: {},
    lastSeenSeq: 0,
  });
  store.advanceThreadSession(thread.id, "reviewer", 7);
  expect(store.getThreadSession(thread.id, "reviewer")).toMatchObject({
    ...reviewer,
    lastSeenSeq: 7,
  });
  expect(store.getThreadSession(thread.id, "default")!.sessionId).toBe(
    "session-two",
  );
  store.close();

  const reopened = new PhiStore(root);
  expect(reopened.getThreadSession(thread.id)).toMatchObject({
    harnessId: "codex",
    agentName: "default",
    sessionId: "session-two",
    model: null,
    config: {},
    lastSeenSeq: 1,
  });
  expect(reopened.getThreadSession(thread.id, "reviewer")).toMatchObject({
    sessionId: "review-session",
    lastSeenSeq: 7,
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

test("multi-agent migration preserves history and re-keys existing sessions", () => {
  const root = tempDir();
  const db = new Database(join(root, "phi.db"), { create: true });
  db.run("PRAGMA foreign_keys = ON");
  db.run(m001);
  db.run(m002);
  db.run(m003);
  db.run(m004);
  db.run(
    "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  for (const id of [
    "001_init",
    "002_thread_turn_state",
    "003_thread_sessions",
    "004_message_search",
  ]) {
    db.query(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
    ).run(id, "2026-01-01T00:00:00.000Z");
  }
  db.query(
    "INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)",
  ).run("ws_old", "old", root, "now", "now");
  db.query(
    "INSERT INTO channels VALUES (?, ?, ?, ?, ?, ?)",
  ).run("ch_old", "ws_old", "general", null, "now", "now");
  db.query(
    `INSERT INTO threads
       (id, workspace_id, channel_id, title, status, last_seq, created_at, updated_at, turn_active, turn_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("th_old", "ws_old", "ch_old", "Old", "open", 1, "now", "now", 0, null);
  db.query(
    `INSERT INTO messages
       (id, workspace_id, channel_id, thread_id, author, kind, content, metadata_json, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "msg_old",
    "ws_old",
    "ch_old",
    "th_old",
    "coordinator",
    "message",
    "legacy reply",
    "{}",
    1,
    "now",
  );
  db.query(
    `INSERT INTO thread_sessions
       (thread_id, harness_id, agent_name, session_id, model, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("th_old", "codex", "default", "sess_old", null, "{}", "now", "now");
  db.query(
    `INSERT INTO message_search_chunks
       (message_id, workspace_id, channel_id, thread_id, chunk_index, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("msg_old", "ws_old", "ch_old", "th_old", 0, "legacy reply", "hash");
  db.close();

  const migrated = new PhiStore(root);
  expect(migrated.listMessages("th_old")[0]).toMatchObject({
    author: "agent",
    metadata: { agent: "default" },
  });
  expect(migrated.getThreadSession("th_old", "default")).toMatchObject({
    sessionId: "sess_old",
    lastSeenSeq: 1,
  });
  expect(
    migrated.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM message_search_chunks WHERE message_id = 'msg_old'",
      )
      .get()!.count,
  ).toBe(1);
  migrated.close();
});
