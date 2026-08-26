import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dbPath, phiRoot, workspaceRoot } from "@/core/paths";
import { migrate } from "@/db/migrate";
import type {
  ActivityItem,
  Channel,
  Message,
  MessageAuthor,
  Thread,
  ThreadSummary,
  ThreadTurn,
  Workspace,
} from "@/shared/types";

const DEFAULT_WORKSPACE_ID = "ws_default";
const DEFAULT_CHANNEL_ID = "ch_general";

const THREAD_TITLE_MAX = 60;

// Emitted after a write transaction commits. The WebSocket hub (and later
// the agent runtime) subscribes; the store itself never talks transport.
export type StoreChange =
  | { type: "channel.updated"; channel: Channel }
  | { type: "message.appended"; message: Message }
  | { type: "thread.updated"; thread: Thread }
  | ({ type: "thread.turn" } & ThreadTurn);

export interface AppendMessageInput {
  author: MessageAuthor;
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CreateChannelInput {
  name: string;
  purpose?: string | null;
  folders?: string[];
}

export interface ThreadSessionBinding {
  threadId: string;
  harnessId: string;
  agentName: string;
  sessionId: string;
  model: string | null;
  config: Record<string, string | boolean>;
  lastSeenSeq: number;
  createdAt: string;
  updatedAt: string;
}

export type SaveThreadSessionBinding = Omit<
  ThreadSessionBinding,
  "createdAt" | "updatedAt"
>;

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
  private readonly listeners = new Set<(change: StoreChange) => void>();

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

  get rootPath(): string {
    return this.root;
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

  createChannel(workspaceId: string, input: CreateChannelInput): Channel {
    const workspace = this.db
      .query<{ id: string }, [string]>("SELECT id FROM workspaces WHERE id = ?")
      .get(workspaceId);
    if (!workspace) throw new Error(`no workspace "${workspaceId}"`);

    const id = newId("ch");
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO channels
           (id, workspace_id, name, purpose, folders_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        input.name,
        input.purpose ?? null,
        JSON.stringify(input.folders ?? []),
        now,
        now,
      );
    const channel = this.getChannel(id)!;
    this.emit({ type: "channel.updated", channel });
    return channel;
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

  listActivity(
    workspaceId: string,
    options: { before?: number; limit?: number } = {},
  ): ActivityItem[] {
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? 50;
    const rows = this.db
      .query<ActivityRow, [string, number, number]>(
        `SELECT
           t.*,
           c.name AS channel_name,
           m.id AS message_id,
           m.author AS message_author,
           m.kind AS message_kind,
           m.content AS message_content,
           m.metadata_json AS message_metadata_json,
           m.created_at AS message_created_at,
           (
             SELECT COUNT(*)
             FROM messages unread
             WHERE unread.thread_id = t.id
               AND unread.seq > COALESCE(r.last_read_seq, 0)
           ) AS unread_count
         FROM threads t
         JOIN channels c ON c.id = t.channel_id
         JOIN messages m ON m.thread_id = t.id AND m.seq = t.last_seq
         LEFT JOIN thread_reads r ON r.thread_id = t.id
         WHERE t.workspace_id = ? AND m.seq < ?
         ORDER BY m.seq DESC
         LIMIT ?`,
      )
      .all(workspaceId, before, limit);

    return rows.map((row) => ({
      thread: threadFromRow(row),
      channelName: row.channel_name,
      latestMessage: messageFromRow({
        id: row.message_id,
        workspace_id: row.workspace_id,
        channel_id: row.channel_id,
        thread_id: row.id,
        author: row.message_author,
        kind: row.message_kind,
        content: row.message_content,
        metadata_json: row.message_metadata_json,
        seq: row.last_seq,
        created_at: row.message_created_at,
      }),
      unreadCount: row.unread_count,
    }));
  }

  markThreadRead(threadId: string): boolean {
    const result = this.db
      .query(
        `INSERT INTO thread_reads (thread_id, last_read_seq)
         SELECT id, last_seq FROM threads WHERE id = ?
         ON CONFLICT(thread_id) DO UPDATE SET
           last_read_seq = MAX(thread_reads.last_read_seq, excluded.last_read_seq)`,
      )
      .run(threadId);
    return result.changes > 0;
  }

  rootMessage(threadId: string): Message | null {
    const row = this.db
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE thread_id = ? ORDER BY seq LIMIT 1",
      )
      .get(threadId);
    return row ? messageFromRow(row) : null;
  }

  getThreadSession(
    threadId: string,
    agentName = "default",
  ): ThreadSessionBinding | null {
    const row = this.db
      .query<ThreadSessionRow, [string, string]>(
        "SELECT * FROM thread_agent_sessions WHERE thread_id = ? AND agent_name = ?",
      )
      .get(threadId, agentName);
    return row ? threadSessionFromRow(row) : null;
  }

  saveThreadSession(input: SaveThreadSessionBinding): ThreadSessionBinding {
    if (!this.getThread(input.threadId)) {
      throw new Error(`no thread "${input.threadId}"`);
    }
    const existing = this.getThreadSession(input.threadId, input.agentName);
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO thread_agent_sessions
           (thread_id, harness_id, agent_name, session_id, model, config_json, last_seen_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, agent_name) DO UPDATE SET
           harness_id = excluded.harness_id,
           session_id = excluded.session_id,
           model = excluded.model,
           config_json = excluded.config_json,
           last_seen_seq = excluded.last_seen_seq,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.threadId,
        input.harnessId,
        input.agentName,
        input.sessionId,
        input.model,
        JSON.stringify(input.config),
        input.lastSeenSeq,
        existing?.createdAt ?? now,
        now,
      );
    return this.getThreadSession(input.threadId, input.agentName)!;
  }

  advanceThreadSession(
    threadId: string,
    agentName: string,
    lastSeenSeq: number,
  ): void {
    this.db
      .query(
        `UPDATE thread_agent_sessions
         SET last_seen_seq = MAX(last_seen_seq, ?), updated_at = ?
         WHERE thread_id = ? AND agent_name = ?`,
      )
      .run(lastSeenSeq, new Date().toISOString(), threadId, agentName);
  }

  updateMessageMetadata(
    messageId: string,
    metadata: Record<string, unknown>,
  ): void {
    this.db
      .query("UPDATE messages SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(metadata), messageId);
  }

  listActiveTurns(workspaceId: string): ThreadTurn[] {
    return this.db
      .query<Pick<ThreadRow, "id" | "turn_agent">, [string]>(
        `SELECT id, turn_agent FROM threads
         WHERE workspace_id = ? AND turn_active = 1`,
      )
      .all(workspaceId)
      .map((row) => ({
        threadId: row.id,
        active: true,
        agent: row.turn_agent,
      }));
  }

  setThreadTurn(
    threadId: string,
    active: boolean,
    agent: string | null,
  ): ThreadTurn {
    if (!this.getThread(threadId)) throw new Error(`no thread "${threadId}"`);
    const activeAgent = active ? agent : null;
    this.db
      .query("UPDATE threads SET turn_active = ?, turn_agent = ? WHERE id = ?")
      .run(active ? 1 : 0, activeAgent, threadId);
    const turn = { threadId, active, agent: activeAgent };
    this.emit({ type: "thread.turn", ...turn });
    return turn;
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
    if (
      input.author === "agent" &&
      typeof input.metadata?.agent !== "string"
    ) {
      throw new Error('agent messages require metadata.agent');
    }

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
    for (const listener of this.listeners) listener(change);
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
  folders_json: string;
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
  turn_active: number;
  turn_agent: string | null;
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

interface ActivityRow extends ThreadRow {
  channel_name: string;
  message_id: string;
  message_author: string;
  message_kind: string;
  message_content: string;
  message_metadata_json: string;
  message_created_at: string;
  unread_count: number;
}

interface ThreadSessionRow {
  thread_id: string;
  harness_id: string;
  agent_name: string;
  session_id: string;
  model: string | null;
  config_json: string;
  last_seen_seq: number;
  created_at: string;
  updated_at: string;
}

function threadFromRow(row: ThreadRow): Thread {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    title: row.title,
    status: row.status as Thread["status"],
    lastSeq: row.last_seq,
    turnActive: row.turn_active === 1,
    turnAgent: row.turn_agent,
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

function threadSessionFromRow(row: ThreadSessionRow): ThreadSessionBinding {
  return {
    threadId: row.thread_id,
    harnessId: row.harness_id,
    agentName: row.agent_name,
    sessionId: row.session_id,
    model: row.model,
    config: JSON.parse(row.config_json) as Record<string, string | boolean>,
    lastSeenSeq: row.last_seen_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function channelFromRow(row: ChannelRow): Channel {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    purpose: row.purpose,
    folders: JSON.parse(row.folders_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
