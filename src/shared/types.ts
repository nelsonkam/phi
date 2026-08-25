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
  createdAt: string;
  updatedAt: string;
}

export type ThreadStatus = "open" | "settled" | "archived";

export interface Thread {
  id: string;
  workspaceId: string;
  channelId: string;
  title: string | null;
  status: ThreadStatus;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

export type MessageAuthor = "user" | "coordinator" | "worker" | "system";

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

// An agent definition, loaded from `.agents/agents/<name>.md` in the
// workspace. The name is the filename and doubles as the @-mention handle.
export interface Agent {
  name: string;
  description: string | null;
  harness: string;
  model: string | null;
  warnings: string[];
}

export interface AgentLoadError {
  file: string;
  message: string;
}

// WebSocket frames, server -> client. `v` is the protocol version.
export type ServerFrame =
  | { v: 1; type: "hello"; workspaceId: string }
  | { v: 1; type: "message.appended"; message: Message }
  | { v: 1; type: "thread.updated"; thread: Thread };
