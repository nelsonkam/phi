// Wire types shared between server and clients (web now, mobile later).
// This module must not import from core/, server/, or web/.

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  purpose: string | null;
  folders: string[];
  createdAt: string;
  updatedAt: string;
}

export type ThreadStatus = "open" | "settled" | "archived";

export type ThreadKind = "chat" | "doc_comment";

export interface Thread {
  id: string;
  workspaceId: string;
  channelId: string;
  title: string | null;
  status: ThreadStatus;
  kind: ThreadKind;
  lastSeq: number;
  turnActive: boolean;
  turnAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocCommentAnchor {
  threadId: string;
  rootId: string;
  path: string;
  quote: string;
  prefix: string;
  suffix: string;
  headingSlug: string | null;
}

export interface DocCommentThread {
  thread: Thread;
  anchor: DocCommentAnchor;
  messageCount: number;
  rootMessage: Message | null;
  latestMessage: Message | null;
  unreadCount: number;
}

export interface DocCommentDocSummary {
  rootId: string;
  path: string;
  commentCount: number;
  unreadCount: number;
}

// A thread as rendered in a channel's message flow: the root message plus
// reply metadata.
export interface ThreadSummary extends Thread {
  messageCount: number;
  rootMessage: Message | null;
  latestMessage: Message | null;
  unreadCount: number;
}

export type MessageAuthor = "user" | "agent" | "system";

export interface Message {
  id: string;
  workspaceId: string;
  channelId: string;
  threadId: string;
  author: MessageAuthor;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
  seq: number;
  createdAt: string;
}

// A client-uploaded blob stored under $PHI_ROOT/uploads, never a workspace
// path. Messages reference these by id in metadata.attachments; bytes stay
// on authenticated HTTP, not /ws.
export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
}

export interface ActivityItem {
  thread: Thread;
  channelName: string;
  latestMessage: Message;
  unreadCount: number;
}

export interface ActivityPage {
  activity: ActivityItem[];
  waitingCount: number;
}

export type CheckpointTrigger =
  | "baseline"
  | "turn"
  | "startup"
  | "manual"
  | "shutdown";

export interface GitCheckpoint {
  id: string;
  workspaceId: string;
  commitSha: string;
  trigger: CheckpointTrigger;
  triggerThreadId: string | null;
  createdAt: string;
}

export interface CheckpointHealth {
  status: "ok" | "degraded";
  error: string | null;
  lastSha: string | null;
}

export type RemoteHealthStatus = "unset" | "pending" | "ok" | "degraded";

export interface RemoteHealth {
  status: RemoteHealthStatus;
  configured: boolean;
  displayUrl: string | null;
  lastPushedSha: string | null;
  error: string | null;
}

export type RestoreScope = "scratch" | "all";

export interface ThreadTurn {
  threadId: string;
  active: boolean;
  agent: string | null;
}

// An agent definition, loaded from `.agents/agents/<name>.md` in the
// workspace. The name is the filename and doubles as the @-mention handle.
export interface Agent {
  name: string;
  description: string | null;
  harness: string;
  model: string | null;
  // Harness session config choices (effort, fast mode, ...), keyed by the
  // config option id the harness advertises over ACP. Unset keys mean the
  // harness default.
  config: Record<string, string | boolean>;
  role: "default" | null;
  warnings: string[];
}

export interface AgentLoadError {
  file: string;
  message: string;
}

// A harness phi can launch agents on, with its live install state on this
// machine.
export interface HarnessStatus {
  id: string;
  name: string;
  installed: boolean;
  installHint: string;
}

export interface HarnessConfigChoice {
  value: string;
  name: string;
  description: string | null;
}

// One session config option a harness advertises over ACP (model, effort,
// fast mode, permission mode, ...). `category` carries the spec's semantic
// grouping; "model" powers the model picker.
export type HarnessConfigOption =
  | {
      id: string;
      name: string;
      description: string | null;
      category: string | null;
      type: "select";
      currentValue: string;
      choices: HarnessConfigChoice[];
    }
  | {
      id: string;
      name: string;
      description: string | null;
      category: string | null;
      type: "boolean";
      currentValue: boolean;
    };

// Result of probing a harness (over ACP) for its config options. `error` and
// `options` are mutually exclusive. `loginHint` is the terminal command that
// fixes an authentication failure.
export type HarnessConfig =
  | { options: HarnessConfigOption[]; error?: never; loginHint?: never }
  | { error: string; loginHint?: string; options?: never };

// WebSocket frames, server -> client. `v` is the protocol version.
export type ServerFrame =
  | {
      v: 1;
      type: "hello";
      workspaceId: string;
      activeTurns: ThreadTurn[];
    }
  | { v: 1; type: "channel.updated"; channel: Channel }
  | { v: 1; type: "message.appended"; message: Message }
  | { v: 1; type: "thread.updated"; thread: Thread }
  | ({ v: 1; type: "thread.turn" } & ThreadTurn);
