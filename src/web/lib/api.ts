import type {
  ActivityPage,
  Agent,
  AgentLoadError,
  Attachment,
  Channel,
  DocCommentAnchor,
  DocCommentDocSummary,
  DocCommentThread,
  HarnessConfig,
  HarnessStatus,
  Message,
  Thread,
  ThreadSummary,
} from "@/shared/types";
import type { MessageSearchResponse } from "@/core/search/types";

// The only file (with ws.ts) that knows the transport. Everything else
// consumes typed results, so a future mobile client mirrors just these two.

export async function fetchAuthSession(): Promise<{ ok: true }> {
  const res = await fetch("/api/v1/auth/session", { credentials: "include" });
  if (!res.ok) throw new Error(`GET /auth/session failed: ${res.status}`);
  return res.json() as Promise<{ ok: true }>;
}

export function fetchChannels(): Promise<{ channels: Channel[] }> {
  return get("/channels");
}

export function fetchThreads(
  channelId: string,
): Promise<{ threads: ThreadSummary[] }> {
  return get(`/channels/${channelId}/threads`);
}

export function fetchActivity(
  before: number | undefined,
  limit: number,
): Promise<ActivityPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before !== undefined) params.set("before", String(before));
  return get(`/activity?${params}`);
}

export function searchMessages(
  query: string,
  limit?: number,
): Promise<MessageSearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (limit !== undefined) params.set("limit", String(limit));
  return get(`/search?${params}`);
}

export function fetchMessages(
  threadId: string,
): Promise<{ messages: Message[] }> {
  return get(`/threads/${threadId}/messages`);
}

export function fetchThread(threadId: string): Promise<{
  thread: Thread;
  anchor: DocCommentAnchor | null;
}> {
  return get(`/threads/${threadId}`);
}

export function fetchDocComments(
  channelId: string,
  rootId: string,
  path: string,
): Promise<{ comments: DocCommentThread[] }> {
  const params = new URLSearchParams({ root: rootId, path });
  return get(`/channels/${channelId}/doc-comments?${params}`);
}

export function fetchDocCommentSummary(
  channelId: string,
  parentThreadId?: string,
): Promise<{ docs: DocCommentDocSummary[] }> {
  const params = parentThreadId
    ? `?parentThreadId=${encodeURIComponent(parentThreadId)}`
    : "";
  return get(`/channels/${channelId}/doc-comments/summary${params}`);
}

export function createDocComment(
  channelId: string,
  input: {
    content: string;
    attachmentIds?: string[];
    rootId: string;
    path: string;
    quote: string;
    prefix: string;
    suffix: string;
    headingSlug?: string | null;
    parentThreadId?: string | null;
  },
): Promise<{ thread: Thread; message: Message }> {
  return post(`/channels/${channelId}/doc-comments`, input);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `GET ${path} failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `POST ${path} failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `PATCH ${path} failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function createThread(
  channelId: string,
  input: { content: string; attachmentIds?: string[] },
): Promise<{ thread: Thread; message: Message }> {
  return post(`/channels/${channelId}/threads`, {
    content: input.content,
    attachmentIds: input.attachmentIds,
  });
}

export function sendMessage(
  threadId: string,
  input: { content: string; attachmentIds?: string[] },
): Promise<{ message: Message }> {
  return post(`/threads/${threadId}/messages`, {
    content: input.content,
    attachmentIds: input.attachmentIds,
  });
}

export function updateThreadStatus(
  threadId: string,
  status: Thread["status"],
): Promise<{ thread: Thread }> {
  return patch(`/threads/${threadId}`, { status });
}

export async function uploadAttachment(file: File): Promise<Attachment> {
  const body = new FormData();
  body.append("file", file, file.name);
  const res = await fetch("/api/v1/attachments", {
    method: "POST",
    body,
    credentials: "include",
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Upload failed (${res.status})`);
  }
  const payload = (await res.json()) as { attachment: Attachment };
  return payload.attachment;
}

export function retryTurn(threadId: string): Promise<{ ok: boolean }> {
  return post(`/threads/${threadId}/retry`, {});
}

export function cancelTurn(threadId: string): Promise<{ ok: boolean }> {
  return post(`/threads/${threadId}/cancel`, {});
}

export function markThreadRead(threadId: string): Promise<{ ok: boolean }> {
  return post(`/threads/${threadId}/read`, {});
}

export function markAllRead(): Promise<{ ok: boolean }> {
  return post("/activity/read", {});
}

export function fetchAgents(): Promise<{
  agents: Agent[];
  errors: AgentLoadError[];
}> {
  return get("/agents");
}

export function fetchSetupStatus(): Promise<{ configured: boolean }> {
  return get("/setup/status");
}

export function fetchHarnesses(): Promise<{ harnesses: HarnessStatus[] }> {
  return get("/harnesses");
}

export async function fetchHarnessConfig(
  harnessId: string,
): Promise<HarnessConfig> {
  const res = await fetch(`/api/v1/harnesses/${harnessId}/config`);
  const body = (await res.json().catch(() => null)) as HarnessConfig | null;
  if (body === null) return { error: `Request failed (${res.status})` };
  return body;
}

export function fetchAgent(
  name: string,
): Promise<{ agent: Agent & { instructions: string } }> {
  return get(`/agents/${name}`);
}

export interface UpdateAgentInput {
  harness: string;
  description?: string;
  model?: string;
  config?: Record<string, string | boolean>;
  instructions: string;
}

export async function updateAgent(
  name: string,
  input: UpdateAgentInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/v1/agents/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `Request failed (${res.status})` };
  }
  return { ok: true };
}

export interface CreateDefaultAgentInput {
  harness: string;
  model?: string;
  config?: Record<string, string | boolean>;
}

export async function createDefaultAgent(
  input: CreateDefaultAgentInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch("/api/v1/setup/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `Request failed (${res.status})` };
  }
  return { ok: true };
}
