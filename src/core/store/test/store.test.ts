import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@/testing/tmpdir";
import { PhiStore } from "../store";
import m001 from "@/db/migrations/001_init.sql" with { type: "text" };
import m002 from "@/db/migrations/002_thread_turn_state.sql" with { type: "text" };
import m003 from "@/db/migrations/003_thread_sessions.sql" with { type: "text" };
import m004 from "@/db/migrations/004_message_search.sql" with { type: "text" };
import m005 from "@/db/migrations/005_multi_agent.sql" with { type: "text" };
import m006 from "@/db/migrations/006_channel_folders.sql" with { type: "text" };
import m007 from "@/db/migrations/007_thread_reads.sql" with { type: "text" };

test("migrates a fresh database and seeds defaults", () => {
  const root = tempDir();
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  expect(workspace.name).toBe("default");
  expect(workspace.rootPath).toBe(join(root, "workspace"));

  const channels = store.listChannels(workspace.id);
  expect(channels.map((c) => c.name)).toEqual(["general"]);
  const guide = join(workspace.rootPath, "channels", "general", "AGENTS.md");
  expect(existsSync(guide)).toBe(true);
  expect(readFileSync(guide, "utf8")).toContain("Channel context");
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

test("createAttachment persists metadata and titles attachment-only threads", () => {
  const { store, channel } = chatFixture();
  const id = `att_${"c".repeat(32)}`;
  const created = store.createAttachment({
    id,
    workspaceId: store.defaultWorkspace().id,
    filename: "screenshot.png",
    contentType: "image/png",
    byteSize: 12,
  });
  expect(store.getAttachment(id)).toEqual(created);
  expect(store.getAttachment("att_" + "0".repeat(32))).toBeNull();

  const { thread, message } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "",
    metadata: { attachments: [created] },
  });
  expect(thread.title).toBe("screenshot.png");
  expect(message.content).toBe("");
  store.close();
});

test("creates channels with ordered attached folders", () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const changes: string[] = [];
  store.onChange = (change) => changes.push(change.type);
  const channel = store.createChannel(workspace.id, {
    name: "product-work",
    purpose: "Build the product",
    folders: ["/projects/app", "/projects/docs"],
  });

  expect(channel).toMatchObject({
    workspaceId: workspace.id,
    name: "product-work",
    purpose: "Build the product",
    folders: ["/projects/app", "/projects/docs"],
  });
  expect(store.getChannel(channel.id)).toEqual(channel);
  expect(store.listChannels(workspace.id).find((item) => item.id === channel.id)).toEqual(
    channel,
  );
  expect(changes).toEqual(["channel.updated"]);
  expect(
    existsSync(join(workspace.rootPath, "channels", "product-work", "AGENTS.md")),
  ).toBe(true);
  store.close();
});

test("reopening the store reconciles a missing channel folder", () => {
  const root = tempDir();
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  store.createChannel(workspace.id, { name: "repaired" });
  store.close();
  rmSync(join(workspace.rootPath, "channels", "repaired"), {
    recursive: true,
    force: true,
  });

  const reopened = new PhiStore(root);
  expect(
    existsSync(join(workspace.rootPath, "channels", "repaired", "AGENTS.md")),
  ).toBe(true);
  reopened.close();
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
  const advancedReviewer = store.getThreadSession(thread.id, "reviewer")!;
  expect(advancedReviewer).toMatchObject({
    threadId: reviewer.threadId,
    harnessId: reviewer.harnessId,
    agentName: reviewer.agentName,
    sessionId: reviewer.sessionId,
    model: reviewer.model,
    config: reviewer.config,
    lastSeenSeq: 7,
    createdAt: reviewer.createdAt,
  });
  expect(advancedReviewer.updatedAt >= reviewer.updatedAt).toBe(true);
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
  expect(threads[0]!.latestMessage?.content).toBe("reply");
  expect(threads[1]!.latestMessage?.content).toBe("B");
  expect(threads[1]!.latestMessage?.id).toBe(threads[1]!.rootMessage?.id);
  store.close();
});

test("listActivity returns one latest-message row per thread with cursor pagination", () => {
  const { store, channel } = chatFixture();
  const first = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "First thread",
  });
  const second = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Second thread",
  });
  const latest = store.appendMessage(first.thread.id, {
    author: "agent",
    kind: "message",
    content: "First thread reply",
    metadata: { agent: "default" },
  });

  const page = store.listActivity(first.thread.workspaceId, { limit: 1 });
  expect(page).toHaveLength(1);
  expect(page[0]).toMatchObject({
    thread: { id: first.thread.id },
    channelName: channel.name,
    latestMessage: { id: latest.id, content: "First thread reply" },
    unreadCount: 2,
  });

  const nextPage = store.listActivity(first.thread.workspaceId, {
    before: latest.seq,
  });
  expect(nextPage.map((item) => item.thread.id)).toEqual([second.thread.id]);
  expect(nextPage[0]!.latestMessage.id).toBe(second.message.id);
  store.close();
});

test("markThreadRead advances a monotonic watermark and reports unknown threads", () => {
  const { store, channel } = chatFixture();
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Read state",
  });

  expect(store.markThreadRead("th_missing")).toBe(false);
  expect(store.markThreadRead(thread.id)).toBe(true);
  expect(store.listActivity(thread.workspaceId)[0]!.unreadCount).toBe(0);

  store.appendMessage(thread.id, {
    author: "agent",
    kind: "message",
    content: "A new reply",
    metadata: { agent: "default" },
  });
  expect(store.listActivity(thread.workspaceId)[0]!.unreadCount).toBe(1);

  expect(store.markThreadRead(thread.id)).toBe(true);
  expect(store.listActivity(thread.workspaceId)[0]!.unreadCount).toBe(0);
  store.close();
});

test("countWaitingThreads counts unread agent replies and ignores working or read threads", () => {
  const { store, channel } = chatFixture();
  const waiting = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Waiting",
  });
  store.appendMessage(waiting.thread.id, {
    author: "agent",
    kind: "message",
    content: "Reply",
    metadata: { agent: "default" },
  });

  store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "You last",
  });

  const working = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Working",
  });
  store.appendMessage(working.thread.id, {
    author: "agent",
    kind: "message",
    content: "Still going",
    metadata: { agent: "default" },
  });
  store.setThreadTurn(working.thread.id, true, "default");

  const read = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Already seen",
  });
  store.appendMessage(read.thread.id, {
    author: "agent",
    kind: "message",
    content: "Seen reply",
    metadata: { agent: "default" },
  });
  store.markThreadRead(read.thread.id);

  expect(store.countWaitingThreads(waiting.thread.workspaceId)).toBe(1);

  store.markThreadRead(waiting.thread.id);
  expect(store.countWaitingThreads(waiting.thread.workspaceId)).toBe(0);
  store.close();
});

test("markAllThreadsRead clears every thread in the workspace", () => {
  const { store, channel } = chatFixture();
  const first = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "First",
  });
  store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Second",
  });

  store.markAllThreadsRead(first.thread.workspaceId);
  const activity = store.listActivity(first.thread.workspaceId);
  expect(activity).toHaveLength(2);
  expect(activity.map((item) => item.unreadCount)).toEqual([0, 0]);

  store.appendMessage(first.thread.id, {
    author: "agent",
    kind: "message",
    content: "New reply",
    metadata: { agent: "default" },
  });
  expect(store.listActivity(first.thread.workspaceId)[0]!.unreadCount).toBe(1);
  store.close();
});

test("doc-comment threads stay out of chat gates and survive mark-all-read", () => {
  const { store, channel } = chatFixture();
  const chat = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Chat",
  });
  const comment = store.createDocComment(
    channel.id,
    { author: "user", kind: "message", content: "Looks off" },
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      quote: "unique quote",
      prefix: "before ",
      suffix: " after",
      headingSlug: "intro",
    },
  );
  expect(store.getDocCommentAnchor(comment.thread.id)?.quote).toBe("unique quote");
  expect(store.getDocCommentAnchor(comment.thread.id)?.parentThreadId).toBeNull();
  expect(
    store.listDocComments(channel.id, "workspace", "channels/general/notes.md")[0]!
      .unreadCount,
  ).toBe(0);

  store.appendMessage(comment.thread.id, {
    author: "agent",
    kind: "message",
    content: "Noted",
    metadata: { agent: "default" },
  });

  expect(comment.thread.kind).toBe("doc_comment");
  expect(store.listThreads(channel.id).map((t) => t.id)).toEqual([chat.thread.id]);
  expect(store.listActivity(chat.thread.workspaceId).map((item) => item.thread.id)).toEqual([
    chat.thread.id,
  ]);
  expect(store.countWaitingThreads(chat.thread.workspaceId)).toBe(0);

  const listed = store.listDocComments(
    channel.id,
    "workspace",
    "channels/general/notes.md",
  );
  expect(listed).toHaveLength(1);
  expect(listed[0]!.unreadCount).toBe(1);
  expect(store.listDocCommentSummary(channel.id)).toEqual([
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      commentCount: 1,
      unreadCount: 1,
    },
  ]);

  store.markAllThreadsRead(chat.thread.workspaceId);
  expect(store.listActivity(chat.thread.workspaceId)[0]!.unreadCount).toBe(0);
  expect(
    store.listDocComments(channel.id, "workspace", "channels/general/notes.md")[0]!
      .unreadCount,
  ).toBe(1);
  store.close();
});

test("doc-comment anchors record a parent thread and fall back to a linking message", () => {
  const { store, channel } = chatFixture();
  const parent = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Discuss [notes](channels/general/notes.md)",
  });
  const comment = store.createDocComment(
    channel.id,
    { author: "user", kind: "message", content: "Looks off" },
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      quote: "unique quote",
      prefix: "before ",
      suffix: " after",
      headingSlug: "intro",
      parentThreadId: parent.thread.id,
    },
  );
  expect(store.getDocCommentAnchor(comment.thread.id)?.parentThreadId).toBe(
    parent.thread.id,
  );
  expect(
    store.findDocCommentParent(
      channel.id,
      "workspace",
      "channels/general/notes.md",
    ),
  ).toBe(parent.thread.id);
  store.setThreadStatus(comment.thread.id, "settled");
  expect(store.listDocCommentSummary(channel.id)).toEqual([]);
  store.close();
});

test("doc-comment summary can filter to a parent thread", () => {
  const { store, channel } = chatFixture();
  const parentA = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Discuss [notes](channels/general/notes.md)",
  });
  const parentB = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Also [spec](channels/general/spec.md)",
  });
  store.createDocComment(
    channel.id,
    { author: "user", kind: "message", content: "Notes comment" },
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      quote: "notes quote",
      prefix: "before ",
      suffix: " after",
      headingSlug: "intro",
      parentThreadId: parentA.thread.id,
    },
  );
  store.createDocComment(
    channel.id,
    { author: "user", kind: "message", content: "Spec comment" },
    {
      rootId: "workspace",
      path: "channels/general/spec.md",
      quote: "spec quote",
      prefix: "before ",
      suffix: " after",
      headingSlug: "intro",
      parentThreadId: parentB.thread.id,
    },
  );
  store.createDocComment(
    channel.id,
    { author: "user", kind: "message", content: "Notes from B" },
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      quote: "second notes quote",
      prefix: "before ",
      suffix: " after",
      headingSlug: "intro",
      parentThreadId: parentB.thread.id,
    },
  );

  expect(store.listDocCommentSummary(channel.id)).toEqual([
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      commentCount: 2,
      unreadCount: 0,
    },
    {
      rootId: "workspace",
      path: "channels/general/spec.md",
      commentCount: 1,
      unreadCount: 0,
    },
  ]);
  expect(store.listDocCommentSummary(channel.id, parentA.thread.id)).toEqual([
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      commentCount: 1,
      unreadCount: 0,
    },
  ]);
  expect(store.listDocCommentSummary(channel.id, parentB.thread.id)).toEqual([
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      commentCount: 1,
      unreadCount: 0,
    },
    {
      rootId: "workspace",
      path: "channels/general/spec.md",
      commentCount: 1,
      unreadCount: 0,
    },
  ]);
  store.close();
});

test("doc-comment parent fallback requires a file link and the workspace root", () => {
  const { store, channel } = chatFixture();
  store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "I copied channels/general/notes.md.bak into the other folder",
  });
  store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "plain prose about notes.md",
  });
  expect(
    store.findDocCommentParent(
      channel.id,
      "workspace",
      "channels/general/notes.md",
    ),
  ).toBeNull();

  const linked = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "See [notes](channels/general/notes.md)",
  });
  expect(
    store.findDocCommentParent(
      channel.id,
      "workspace",
      "channels/general/notes.md",
    ),
  ).toBe(linked.thread.id);
  expect(
    store.findDocCommentParent(
      channel.id,
      "attached-root",
      "channels/general/notes.md",
    ),
  ).toBeNull();
  store.close();
});

test("doc-comment parent fallback matches percent-encoded file hrefs", () => {
  const { store, channel } = chatFixture();
  const spaces = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "See [report](channels/general/My%20Report.md)",
  });
  expect(
    store.findDocCommentParent(
      channel.id,
      "workspace",
      "channels/general/My Report.md",
    ),
  ).toBe(spaces.thread.id);

  const cafe = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "See [notes](channels/caf%c3%a9.md)",
  });
  expect(
    store.findDocCommentParent(channel.id, "workspace", "channels/café.md"),
  ).toBe(cafe.thread.id);
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

test("checkpoint latest follows insertion order when timestamps and ids disagree", () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const createdAt = "2026-01-01T00:00:00.000Z";
  store.insertCheckpoint({
    id: "cp_zzz",
    workspaceId: workspace.id,
    commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    trigger: "baseline",
    createdAt,
  });
  store.insertCheckpoint({
    id: "cp_aaa",
    workspaceId: workspace.id,
    commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    trigger: "turn",
    createdAt,
  });
  expect(store.latestCheckpoint(workspace.id)?.id).toBe("cp_aaa");
  expect(store.listCheckpoints(workspace.id).map((row) => row.id)).toEqual([
    "cp_aaa",
    "cp_zzz",
  ]);
  store.close();
});

test("009 copies legacy 008 rows by rowid, not timestamp or id", () => {
  const root = tempDir();
  const db = new Database(join(root, "phi.db"), { create: true });
  db.run("PRAGMA foreign_keys = ON");
  for (const sql of [m001, m002, m003, m004, m005, m006, m007]) {
    db.run(sql);
  }
  db.run(`
    CREATE TABLE git_checkpoints (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      commit_sha TEXT NOT NULL UNIQUE,
      trigger TEXT NOT NULL CHECK (trigger IN ('baseline', 'turn', 'startup', 'manual', 'shutdown')),
      trigger_thread_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX git_checkpoints_workspace_created
      ON git_checkpoints (workspace_id, created_at, id)
  `);
  db.run(
    "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  for (const id of [
    "001_init",
    "002_thread_turn_state",
    "003_thread_sessions",
    "004_message_search",
    "005_multi_agent",
    "006_channel_folders",
    "007_thread_reads",
    "008_git_checkpoints",
  ]) {
    db.query(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
    ).run(id, "2026-01-01T00:00:00.000Z");
  }
  const createdAt = "2026-01-01T00:00:00.000Z";
  db.query(
    "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ws_default", "default", join(root, "workspace"), createdAt, createdAt);
  db.query(
    `INSERT INTO git_checkpoints
       (id, workspace_id, commit_sha, trigger, trigger_thread_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "cp_zzz",
    "ws_default",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "baseline",
    null,
    createdAt,
  );
  db.query(
    `INSERT INTO git_checkpoints
       (id, workspace_id, commit_sha, trigger, trigger_thread_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "cp_aaa",
    "ws_default",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "turn",
    null,
    createdAt,
  );
  db.close();

  const store = new PhiStore(root);
  expect(store.latestCheckpoint("ws_default")?.id).toBe("cp_aaa");
  expect(store.listCheckpoints("ws_default").map((row) => row.id)).toEqual([
    "cp_aaa",
    "cp_zzz",
  ]);
  store.close();
});
