import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dbPath, phiRoot, workspaceRoot } from "@/core/paths";
import {
  ensureChannelWorkspace,
  reconcileChannelWorkspaces,
} from "@/core/workspace";
import { migrate } from "@/db/migrate";
import { messageContainsFileLink } from "@/shared/file-link-match";
import type {
  ActivityItem,
  Attachment,
  Channel,
  CheckpointTrigger,
  DocCommentAnchor,
  DocCommentDocSummary,
  DocCommentThread,
  GitCheckpoint,
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
  mcpFingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export type SaveThreadSessionBinding = Omit<
  ThreadSessionBinding,
  "createdAt" | "updatedAt" | "mcpFingerprint"
> & { mcpFingerprint?: string };

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function threadTitle(
  content: string,
  metadata?: Record<string, unknown>,
): string {
  const firstLine = content.trim().split("\n", 1)[0] ?? "";
  if (firstLine) {
    return firstLine.length > THREAD_TITLE_MAX
      ? `${firstLine.slice(0, THREAD_TITLE_MAX - 1)}…`
      : firstLine;
  }
  const attachments = metadata?.attachments;
  if (Array.isArray(attachments)) {
    const first = attachments[0];
    if (first && typeof first === "object" && "filename" in first) {
      const filename = (first as { filename: unknown }).filename;
      if (typeof filename === "string" && filename.trim()) {
        const name = filename.trim();
        return name.length > THREAD_TITLE_MAX
          ? `${name.slice(0, THREAD_TITLE_MAX - 1)}…`
          : name;
      }
    }
    if (attachments.length > 0) return "File";
  }
  return "Message";
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
    this.reconcileChannelFolders();
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

  createAttachment(input: {
    id: string;
    workspaceId: string;
    filename: string;
    contentType: string;
    byteSize: number;
  }): Attachment {
    const createdAt = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO attachments (id, workspace_id, filename, content_type, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.filename,
        input.contentType,
        input.byteSize,
        createdAt,
      );
    return {
      id: input.id,
      filename: input.filename,
      contentType: input.contentType,
      byteSize: input.byteSize,
      createdAt,
    };
  }

  getAttachment(id: string): Attachment | null {
    const row = this.db
      .query<AttachmentRow, [string]>("SELECT * FROM attachments WHERE id = ?")
      .get(id);
    return row ? attachmentFromRow(row) : null;
  }

  listChannels(workspaceId: string): Channel[] {
    return this.db
      .query<ChannelRow, [string]>(
        "SELECT * FROM channels WHERE workspace_id = ? ORDER BY name",
      )
      .all(workspaceId)
      .map(channelFromRow);
  }

  reconcileChannelFolders(): void {
    const workspace = this.defaultWorkspace();
    reconcileChannelWorkspaces(
      workspace.rootPath,
      this.listChannels(workspace.id).map((channel) => channel.name),
    );
  }

  getChannel(channelId: string): Channel | null {
    const row = this.db
      .query<ChannelRow, [string]>("SELECT * FROM channels WHERE id = ?")
      .get(channelId);
    return row ? channelFromRow(row) : null;
  }

  createChannel(workspaceId: string, input: CreateChannelInput): Channel {
    const workspace = this.db
      .query<{ id: string; root_path: string }, [string]>(
        "SELECT id, root_path FROM workspaces WHERE id = ?",
      )
      .get(workspaceId);
    if (!workspace) throw new Error(`no workspace "${workspaceId}"`);

    // Filesystem first: a successful channel row always has durable context.
    // If the insert later fails, the orphan folder is harmless and a retry
    // preserves it.
    ensureChannelWorkspace(workspace.root_path, input.name);

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
      .query<ThreadRow & { message_count: number; unread_count: number }, [string]>(
        `SELECT t.*,
           (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
           (
             SELECT COUNT(*)
             FROM messages unread
             WHERE unread.thread_id = t.id
               AND unread.seq > COALESCE(r.last_read_seq, 0)
           ) AS unread_count
         FROM threads t
         LEFT JOIN thread_reads r ON r.thread_id = t.id
         WHERE t.channel_id = ? AND t.kind = 'chat'
         ORDER BY t.last_seq DESC`,
      )
      .all(channelId);
    const roots = this.messagesAtSeq(channelId, "MIN");
    const latest = this.messagesAtSeq(channelId, "MAX");
    return rows.map((row) => ({
      ...threadFromRow(row),
      messageCount: row.message_count,
      rootMessage: roots.get(row.id) ?? null,
      latestMessage: latest.get(row.id) ?? null,
      unreadCount: row.unread_count,
    }));
  }

  private messagesAtSeq(
    channelId: string,
    which: "MIN" | "MAX",
  ): Map<string, Message> {
    const agg = which === "MIN" ? "MIN(seq)" : "MAX(seq)";
    return new Map(
      this.db
        .query<MessageRow, [string]>(
          `SELECT m.* FROM messages m
           JOIN threads t ON m.thread_id = t.id
           JOIN (
             SELECT m2.thread_id, ${agg} AS edge_seq
             FROM messages m2
             JOIN threads t2 ON m2.thread_id = t2.id
             WHERE m2.channel_id = ? AND t2.kind = 'chat'
             GROUP BY m2.thread_id
           ) r ON m.thread_id = r.thread_id AND m.seq = r.edge_seq
           WHERE t.kind = 'chat'`,
        )
        .all(channelId)
        .map((row) => [row.thread_id, messageFromRow(row)] as const),
    );
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
         WHERE t.workspace_id = ? AND t.kind = 'chat' AND m.seq < ?
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

  // Threads whose latest message is an unread agent reply and nobody is
  // mid-turn — the same "waiting" gate the sidebar badge and channel dots use.
  countWaitingThreads(workspaceId: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n
         FROM threads t
         JOIN messages m ON m.thread_id = t.id AND m.seq = t.last_seq
         LEFT JOIN thread_reads r ON r.thread_id = t.id
         WHERE t.workspace_id = ?
           AND t.kind = 'chat'
           AND t.turn_active = 0
           AND m.author = 'agent'
           AND EXISTS (
             SELECT 1
             FROM messages unread
             WHERE unread.thread_id = t.id
               AND unread.seq > COALESCE(r.last_read_seq, 0)
           )`,
      )
      .get(workspaceId);
    return row?.n ?? 0;
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

  // "Mark all read" as one server-side write, so it covers every thread in
  // the workspace regardless of how much of the feed a client has loaded.
  markAllThreadsRead(workspaceId: string): void {
    this.db
      .query(
        `INSERT INTO thread_reads (thread_id, last_read_seq)
         SELECT id, last_seq FROM threads WHERE workspace_id = ? AND kind = 'chat'
         ON CONFLICT(thread_id) DO UPDATE SET
           last_read_seq = MAX(thread_reads.last_read_seq, excluded.last_read_seq)`,
      )
      .run(workspaceId);
  }

  setThreadStatus(threadId: string, status: Thread["status"]): Thread | null {
    if (!this.getThread(threadId)) return null;
    const now = new Date().toISOString();
    this.db
      .query("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?",)
      .run(status, now, threadId);
    const thread = this.getThread(threadId)!;
    this.emit({ type: "thread.updated", thread });
    return thread;
  }

  rootMessage(threadId: string): Message | null {
    const row = this.db
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE thread_id = ? ORDER BY seq LIMIT 1",
      )
      .get(threadId);
    return row ? messageFromRow(row) : null;
  }

  lastAgentMessage(threadId: string): Message | null {
    const row = this.db
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE thread_id = ? AND author = 'agent' ORDER BY seq DESC LIMIT 1",
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
           (thread_id, harness_id, agent_name, session_id, model, config_json, last_seen_seq, mcp_fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, agent_name) DO UPDATE SET
           harness_id = excluded.harness_id,
           session_id = excluded.session_id,
           model = excluded.model,
           config_json = excluded.config_json,
           last_seen_seq = excluded.last_seen_seq,
           mcp_fingerprint = excluded.mcp_fingerprint,
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
        input.mcpFingerprint ?? "absent",
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
          `INSERT INTO threads (id, workspace_id, channel_id, title, status, last_seq, created_at, updated_at, kind)
           VALUES (?, ?, ?, ?, 'open', 0, ?, ?, 'chat')`,
        )
        .run(
          threadId,
          channel.workspaceId,
          channelId,
          threadTitle(input.content, input.metadata),
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

  createDocComment(
    channelId: string,
    input: AppendMessageInput,
    anchor: {
      rootId: string;
      path: string;
      quote: string;
      prefix: string;
      suffix: string;
      headingSlug: string | null;
      parentThreadId?: string | null;
    },
  ): { thread: Thread; message: Message } {
    const channel = this.getChannel(channelId);
    if (!channel) throw new Error(`no channel "${channelId}"`);

    const threadId = newId("th");
    const now = new Date().toISOString();
    let result: { thread: Thread; message: Message } | null = null;

    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO threads (id, workspace_id, channel_id, title, status, last_seq, created_at, updated_at, kind)
           VALUES (?, ?, ?, ?, 'open', 0, ?, ?, 'doc_comment')`,
        )
        .run(
          threadId,
          channel.workspaceId,
          channelId,
          threadTitle(input.content, input.metadata),
          now,
          now,
        );
      this.db
        .query(
          `INSERT INTO doc_comment_anchors
             (thread_id, root_id, path, quote, prefix, suffix, heading_slug, parent_thread_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          anchor.rootId,
          anchor.path,
          anchor.quote,
          anchor.prefix,
          anchor.suffix,
          anchor.headingSlug,
          anchor.parentThreadId ?? null,
        );
      const message = this.insertMessage(
        channel.workspaceId,
        channelId,
        threadId,
        input,
      );
      result = { thread: this.getThread(threadId)!, message };
    })();

    const { thread, message } = result!;
    this.emit({ type: "thread.updated", thread });
    this.emit({ type: "message.appended", message });
    return { thread, message };
  }

  getDocCommentAnchor(threadId: string): DocCommentAnchor | null {
    const row = this.db
      .query<DocCommentAnchorRow, [string]>(
        "SELECT * FROM doc_comment_anchors WHERE thread_id = ?",
      )
      .get(threadId);
    return row ? docCommentAnchorFromRow(row) : null;
  }

  isChatThreadInChannel(threadId: string, channelId: string): boolean {
    const thread = this.getThread(threadId);
    return Boolean(
      thread && thread.channelId === channelId && thread.kind === "chat",
    );
  }

  // Fallback parent when the client did not send one: a parent already
  // stored on this doc, else the latest chat message that links the path.
  findDocCommentParent(
    channelId: string,
    rootId: string,
    path: string,
  ): string | null {
    const fromComments = this.db
      .query<{ parent_thread_id: string }, [string, string, string]>(
        `SELECT a.parent_thread_id
         FROM doc_comment_anchors a
         JOIN threads t ON t.id = a.thread_id
         JOIN threads parent ON parent.id = a.parent_thread_id
         WHERE t.channel_id = ? AND a.root_id = ? AND a.path = ?
           AND parent.kind = 'chat' AND parent.channel_id = t.channel_id
         ORDER BY t.created_at DESC
         LIMIT 1`,
      )
      .get(channelId, rootId, path);
    if (fromComments?.parent_thread_id) return fromComments.parent_thread_id;

    // Chat messages don't record which file-root a chip pointed at, so a
    // linking-message fallback on an attached root can steal lineage from
    // a workspace file at the same relative path (or vice versa).
    if (rootId !== "workspace") return null;

    const candidates = this.db
      .query<{ thread_id: string; content: string }, [string]>(
        `SELECT m.thread_id, m.content
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
         WHERE t.channel_id = ? AND t.kind = 'chat'
         ORDER BY m.seq DESC`,
      )
      .all(channelId);
    for (const row of candidates) {
      if (messageContainsFileLink(row.content, path)) return row.thread_id;
    }
    return null;
  }

  listDocComments(
    channelId: string,
    rootId: string,
    path: string,
  ): DocCommentThread[] {
    const rows = this.db
      .query<
        ThreadRow & DocCommentAnchorRow & { message_count: number; unread_count: number },
        [string, string, string]
      >(
        `SELECT t.*, a.thread_id, a.root_id, a.path, a.quote, a.prefix, a.suffix, a.heading_slug, a.parent_thread_id,
           (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
           (
             SELECT COUNT(*)
             FROM messages unread
             WHERE unread.thread_id = t.id
               AND unread.seq > COALESCE(r.last_read_seq, 0)
               AND unread.author IN ('agent', 'system')
           ) AS unread_count
         FROM threads t
         JOIN doc_comment_anchors a ON a.thread_id = t.id
         LEFT JOIN thread_reads r ON r.thread_id = t.id
         WHERE t.channel_id = ? AND t.kind = 'doc_comment'
           AND a.root_id = ? AND a.path = ?
         ORDER BY t.created_at ASC`,
      )
      .all(channelId, rootId, path);

    const ids = rows.map((row) => row.id);
    const roots = this.messagesAtSeqForThreads(ids, "MIN");
    const latest = this.messagesAtSeqForThreads(ids, "MAX");
    return rows.map((row) => ({
      thread: threadFromRow(row),
      anchor: docCommentAnchorFromRow(row),
      messageCount: row.message_count,
      rootMessage: roots.get(row.id) ?? null,
      latestMessage: latest.get(row.id) ?? null,
      unreadCount: row.unread_count,
    }));
  }

  listDocCommentSummary(
    channelId: string,
    parentThreadId?: string,
  ): DocCommentDocSummary[] {
    const parent = parentThreadId?.trim() || undefined;
    const sql = `SELECT a.root_id, a.path,
           COUNT(*) AS comment_count,
           SUM((
             SELECT COUNT(*)
             FROM messages unread
             WHERE unread.thread_id = t.id
               AND unread.seq > COALESCE(r.last_read_seq, 0)
               AND unread.author IN ('agent', 'system')
           )) AS unread_count
         FROM doc_comment_anchors a
         JOIN threads t ON t.id = a.thread_id
         LEFT JOIN thread_reads r ON r.thread_id = t.id
         WHERE t.channel_id = ? AND t.kind = 'doc_comment' AND t.status = 'open'
           ${parent ? "AND a.parent_thread_id = ?" : ""}
         GROUP BY a.root_id, a.path
         ORDER BY MAX(t.updated_at) DESC`;
    type SummaryRow = {
      root_id: string;
      path: string;
      comment_count: number;
      unread_count: number;
    };
    const rows = parent
      ? this.db.query<SummaryRow, [string, string]>(sql).all(channelId, parent)
      : this.db.query<SummaryRow, [string]>(sql).all(channelId);
    return rows.map((row) => ({
      rootId: row.root_id,
      path: row.path,
      commentCount: row.comment_count,
      unreadCount: row.unread_count ?? 0,
    }));
  }

  private messagesAtSeqForThreads(
    threadIds: string[],
    which: "MIN" | "MAX",
  ): Map<string, Message> {
    const out = new Map<string, Message>();
    if (threadIds.length === 0) return out;
    const agg = which === "MIN" ? "MIN(seq)" : "MAX(seq)";
    const placeholders = threadIds.map(() => "?").join(", ");
    return new Map(
      this.db
        .query<MessageRow, string[]>(
          `SELECT m.* FROM messages m
           JOIN (
             SELECT thread_id, ${agg} AS edge_seq
             FROM messages WHERE thread_id IN (${placeholders}) GROUP BY thread_id
           ) r ON m.thread_id = r.thread_id AND m.seq = r.edge_seq`,
        )
        .all(...threadIds)
        .map((row) => [row.thread_id, messageFromRow(row)] as const),
    );
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

  insertCheckpoint(input: {
    id: string;
    workspaceId: string;
    commitSha: string;
    trigger: CheckpointTrigger;
    triggerThreadId?: string | null;
    createdAt?: string;
  }): GitCheckpoint {
    const existing = this.checkpointBySha(input.commitSha);
    if (existing) return existing;
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db
      .query(
        `INSERT INTO git_checkpoints
           (id, workspace_id, commit_sha, trigger, trigger_thread_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.commitSha,
        input.trigger,
        input.triggerThreadId ?? null,
        createdAt,
      );
    return this.checkpointBySha(input.commitSha)!;
  }

  listCheckpoints(workspaceId: string): GitCheckpoint[] {
    return this.db
      .query<CheckpointRow, [string]>(
        `SELECT * FROM git_checkpoints
         WHERE workspace_id = ?
         ORDER BY ordinal DESC`,
      )
      .all(workspaceId)
      .map(checkpointFromRow);
  }

  checkpointById(id: string): GitCheckpoint | null {
    const row = this.db
      .query<CheckpointRow, [string]>("SELECT * FROM git_checkpoints WHERE id = ?")
      .get(id);
    return row ? checkpointFromRow(row) : null;
  }

  checkpointBySha(sha: string): GitCheckpoint | null {
    const row = this.db
      .query<CheckpointRow, [string]>(
        "SELECT * FROM git_checkpoints WHERE commit_sha = ?",
      )
      .get(sha);
    return row ? checkpointFromRow(row) : null;
  }

  latestCheckpoint(workspaceId: string): GitCheckpoint | null {
    const row = this.db
      .query<CheckpointRow, [string]>(
        `SELECT * FROM git_checkpoints
         WHERE workspace_id = ?
         ORDER BY ordinal DESC
         LIMIT 1`,
      )
      .get(workspaceId);
    return row ? checkpointFromRow(row) : null;
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
  kind: string;
}

interface DocCommentAnchorRow {
  thread_id: string;
  root_id: string;
  path: string;
  quote: string;
  prefix: string;
  suffix: string;
  heading_slug: string | null;
  parent_thread_id: string | null;
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

interface AttachmentRow {
  id: string;
  workspace_id: string;
  filename: string;
  content_type: string;
  byte_size: number;
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
  mcp_fingerprint: string;
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
    kind: row.kind === "doc_comment" ? "doc_comment" : "chat",
    lastSeq: row.last_seq,
    turnActive: row.turn_active === 1,
    turnAgent: row.turn_agent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function docCommentAnchorFromRow(row: DocCommentAnchorRow): DocCommentAnchor {
  return {
    threadId: row.thread_id,
    rootId: row.root_id,
    path: row.path,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    headingSlug: row.heading_slug,
    parentThreadId: row.parent_thread_id,
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

function attachmentFromRow(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: row.byte_size,
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
    mcpFingerprint: row.mcp_fingerprint,
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

interface CheckpointRow {
  id: string;
  workspace_id: string;
  commit_sha: string;
  trigger: string;
  trigger_thread_id: string | null;
  created_at: string;
}

function checkpointFromRow(row: CheckpointRow): GitCheckpoint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    commitSha: row.commit_sha,
    trigger: row.trigger as CheckpointTrigger,
    triggerThreadId: row.trigger_thread_id,
    createdAt: row.created_at,
  };
}
