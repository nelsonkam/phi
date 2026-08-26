import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dbPath, phiRoot, workspaceRoot } from "@/core/paths";
import { migrate } from "@/db/migrate";
import type {
  Channel,
  Message,
  MessageAuthor,
  Thread,
  ThreadSummary,
  Workspace,
} from "@/shared/types";

const DEFAULT_WORKSPACE_ID = "ws_default";
const DEFAULT_CHANNEL_ID = "ch_general";

const THREAD_TITLE_MAX = 60;

// Emitted after a write transaction commits. The WebSocket hub (and later
// the agent runtime) subscribes; the store itself never talks transport.
export type StoreChange =
  | { type: "message.appended"; message: Message }
  | { type: "thread.updated"; thread: Thread };

export interface AppendMessageInput {
  author: MessageAuthor;
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function threadTitle(content: string): string {
  const firstLine = content.trim().split("\n", 1)[0] ?? "";
  return firstLine.length > THREAD_TITLE_MAX
    ? `${firstLine.slice(0, THREAD_TITLE_MAX - 1)}…`
    : firstLine;
}

export class PhiStore {
  readonly db: Database;
  private readonly root: string;
  // Post-commit change listener; assigned by the server after construction.
  onChange: ((change: StoreChange) => void) | null = null;

  constructor(root: string = phiRoot()) {
    this.root = root;
    mkdirSync(root, { recursive: true });
    this.db = new Database(dbPath(root), { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run("PRAGMA busy_timeout = 5000;");
    migrate(this.db);
    this.seedDefaults();
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT OR IGNORE INTO workspaces (id, name, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(DEFAULT_WORKSPACE_ID, "default", workspaceRoot(this.root), now, now);
    // The default workspace root derives from PHI_ROOT; keep the row in sync
    // when the root moves.
    this.db
      .query(
        "UPDATE workspaces SET root_path = ?, updated_at = ? WHERE id = ? AND root_path != ?",
      )
      .run(workspaceRoot(this.root), now, DEFAULT_WORKSPACE_ID, workspaceRoot(this.root));
    this.db
      .query(
        `INSERT OR IGNORE INTO channels (id, workspace_id, name, purpose, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(DEFAULT_CHANNEL_ID, DEFAULT_WORKSPACE_ID, "general", null, now, now);
  }

  defaultWorkspace(): Workspace {
    const row = this.db
      .query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?")
      .get(DEFAULT_WORKSPACE_ID);
    if (!row) throw new Error("default workspace missing");
    return workspaceFromRow(row);
  }

  listChannels(workspaceId: string): Channel[] {
    return this.db
      .query<ChannelRow, [string]>(
        "SELECT * FROM channels WHERE workspace_id = ? ORDER BY name",
      )
      .all(workspaceId)
      .map(channelFromRow);
  }

  getChannel(channelId: string): Channel | null {
    const row = this.db
      .query<ChannelRow, [string]>("SELECT * FROM channels WHERE id = ?")
      .get(channelId);
    return row ? channelFromRow(row) : null;
  }

  getThread(threadId: string): Thread | null {
    const row = this.db
      .query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?")
      .get(threadId);
    return row ? threadFromRow(row) : null;
  }

  listThreads(channelId: string): ThreadSummary[] {
    const rows = this.db
      .query<ThreadRow & { message_count: number }, [string]>(
        `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
         FROM threads t
         WHERE t.channel_id = ?
         ORDER BY t.last_seq DESC`,
      )
      .all(channelId);
    const roots = new Map(
      this.db
        .query<MessageRow, [string]>(
          `SELECT m.* FROM messages m
           JOIN (
             SELECT thread_id, MIN(seq) AS root_seq
             FROM messages WHERE channel_id = ? GROUP BY thread_id
           ) r ON m.thread_id = r.thread_id AND m.seq = r.root_seq`,
        )
        .all(channelId)
        .map((row) => [row.thread_id, messageFromRow(row)] as const),
    );
    return rows.map((row) => ({
      ...threadFromRow(row),
      messageCount: row.message_count,
      rootMessage: roots.get(row.id) ?? null,
    }));
  }

  listMessages(threadId: string): Message[] {
    return this.db
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE thread_id = ? ORDER BY seq",
      )
      .all(threadId)
      .map(messageFromRow);
  }

  // Creates a thread with its first message in one transaction.
  createThread(
    channelId: string,
    input: AppendMessageInput,
  ): { thread: Thread; message: Message } {
    const channel = this.getChannel(channelId);
    if (!channel) throw new Error(`no channel "${channelId}"`);

    const threadId = newId("th");
    const now = new Date().toISOString();
    let result: { thread: Thread; message: Message } | null = null;

    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO threads (id, workspace_id, channel_id, title, status, last_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', 0, ?, ?)`,
        )
        .run(
          threadId,
          channel.workspaceId,
          channelId,
          threadTitle(input.content),
          now,
          now,
        );
      const message = this.insertMessage(channel.workspaceId, channelId, threadId, input);
      result = { thread: this.getThread(threadId)!, message };
    })();

    const { thread, message } = result!;
    this.emit({ type: "thread.updated", thread });
    this.emit({ type: "message.appended", message });
    return { thread, message };
  }

  // Appends to an existing thread: allocates the next workspace seq, inserts
  // the message, and bumps the thread — one transaction.
  appendMessage(threadId: string, input: AppendMessageInput): Message {
    const thread = this.getThread(threadId);
    if (!thread) throw new Error(`no thread "${threadId}"`);

    const message = this.db
      .transaction(() =>
        this.insertMessage(thread.workspaceId, thread.channelId, threadId, input),
      )() as Message;

    const updated = this.getThread(threadId)!;
    this.emit({ type: "message.appended", message });
    this.emit({ type: "thread.updated", thread: updated });
    return message;
  }

  // Must run inside a transaction.
  private insertMessage(
    workspaceId: string,
    channelId: string,
    threadId: string,
    input: AppendMessageInput,
  ): Message {
    const { seq } = this.db
      .query<{ seq: number }, [string]>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE workspace_id = ?",
      )
      .get(workspaceId)!;
    const id = newId("msg");
    const now = new Date().toISOString();

    this.db
      .query(
        `INSERT INTO messages (id, workspace_id, channel_id, thread_id, author, kind, content, metadata_json, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        channelId,
        threadId,
        input.author,
        input.kind,
        input.content,
        JSON.stringify(input.metadata ?? {}),
        seq,
        now,
      );
    this.db
      .query("UPDATE threads SET last_seq = ?, updated_at = ? WHERE id = ?")
      .run(seq, now, threadId);

    return {
      id,
      workspaceId,
      channelId,
      threadId,
      author: input.author,
      kind: input.kind,
      content: input.content,
      metadata: input.metadata ?? {},
      seq,
      createdAt: now,
    };
  }

  private emit(change: StoreChange): void {
    this.onChange?.(change);
  }

  close(): void {
    this.db.close();
  }
}

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  updated_at: string;
}

interface ChannelRow {
  id: string;
  workspace_id: string;
  name: string;
  purpose: string | null;
  created_at: string;
  updated_at: string;
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ThreadRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  title: string | null;
  status: string;
  last_seq: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  thread_id: string;
  author: string;
  kind: string;
  content: string;
  metadata_json: string;
  seq: number;
  created_at: string;
}

function threadFromRow(row: ThreadRow): Thread {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    title: row.title,
    status: row.status as Thread["status"],
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageFromRow(row: MessageRow): Message {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    author: row.author as MessageAuthor,
    kind: row.kind,
    content: row.content,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    seq: row.seq,
    createdAt: row.created_at,
  };
}

function channelFromRow(row: ChannelRow): Channel {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    purpose: row.purpose,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
