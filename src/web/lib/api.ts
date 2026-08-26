import type {
  ActivityItem,
  Agent,
  AgentLoadError,
  Channel,
  HarnessConfig,
  HarnessStatus,
  Message,
  Thread,
  ThreadSummary,
} from "@/shared/types";

// The only file (with ws.ts) that knows the transport. Everything else
// consumes typed results, so a future mobile client mirrors just these two.

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
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
  before?: number,
): Promise<{ activity: ActivityItem[] }> {
  return get(`/activity${before ? `?before=${before}` : ""}`);
}

export function fetchMessages(
  threadId: string,
): Promise<{ messages: Message[] }> {
  return get(`/threads/${threadId}/messages`);
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

export function createThread(
  channelId: string,
  content: string,
): Promise<{ thread: Thread; message: Message }> {
  return post(`/channels/${channelId}/threads`, { content });
}

export function sendMessage(
  threadId: string,
  content: string,
): Promise<{ message: Message }> {
  return post(`/threads/${threadId}/messages`, { content });
}

export function retryTurn(threadId: string): Promise<{ ok: boolean }> {
  return post(`/threads/${threadId}/retry`, {});
}

export function markThreadRead(threadId: string): Promise<{ ok: boolean }> {
  return post(`/threads/${threadId}/read`, {});
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
