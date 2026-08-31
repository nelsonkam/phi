import index from "@/web/index.html";
import faviconPng from "@/web/favicon.png" with { type: "file" };
import appleTouchIcon from "@/web/apple-touch-icon.png" with { type: "file" };
import { PhiStore } from "@/core/store/store";
import { detectHarnesses } from "@/core/agents/harnesses";
import { HarnessCapabilityService } from "@/core/agents/capabilities";
import { AgentRuntime } from "@/core/agents/runtime";
import { ensureWorkspace } from "@/core/workspace";
import {
  CheckpointBusyError,
  CheckpointHttpError,
  CheckpointService,
} from "@/core/checkpoints";
import { parseRestoreScope } from "@/core/restore-scope";
import type { ServerFrame } from "@/shared/types";
import {
  getAgent,
  getSetupStatus,
  listAgents,
  setupDefaultAgent,
  updateAgent,
} from "@/server/services/agents";
import { createFileHandler } from "@/server/files";
import {
  parseDocCommentBody,
  resolveDocCommentParent,
  resolveMarkdownDoc,
} from "@/server/doc-comments";
import {
  createAttachmentHandlers,
  parseByteLimit,
} from "@/server/uploads";
import { DeviceAuth, requireDeviceAuth, sessionResponse } from "@/server/device-auth";
import {
  DEFAULT_UPLOAD_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_FILES,
  isAttachmentId,
} from "@/shared/attachments";
import type { Attachment } from "@/shared/types";
import { createMcpHandler } from "@/server/mcp";
import { McpTokenRegistry } from "@/server/mcp-token-registry";
import { createMessageSearch } from "@/core/search/message-search";
import { healthPayload } from "@/server/health";
import {
  getGitRemoteSettings,
  putGitRemoteSettings,
} from "@/server/git-remote-settings";
import { ReflectionService } from "@/core/reflection";
import {
  SchedulerService,
  type ScheduledTaskDefinition,
} from "@/core/scheduler";
import { SubscriptionService } from "@/core/subscriptions";

const DEFAULT_PORT = 3141;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_REFLECTION_CRON = "0 3 * * *";
const DAY_MS = 24 * 60 * 60 * 1_000;

export function serverAddress(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  port: number;
} {
  return {
    host: env.PHI_HOST?.trim() || DEFAULT_HOST,
    port: Number(env.PHI_PORT ?? DEFAULT_PORT),
  };
}

export function reflectionIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.PHI_REFLECTION_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function reflectionTaskDefinition(
  env: NodeJS.ProcessEnv = process.env,
): ScheduledTaskDefinition {
  const interval = reflectionIntervalMs(env);
  if (interval !== undefined) {
    return {
      id: "system.reflection",
      handler: "reflection",
      schedule: { kind: "interval", everyMs: interval || DAY_MS },
      catchUp: "run_once",
      enabled: interval > 0,
      initialRun: "now",
    };
  }
  const expression =
    env.PHI_REFLECTION_CRON?.trim() || DEFAULT_REFLECTION_CRON;
  const timezone = env.PHI_REFLECTION_TIMEZONE?.trim() || undefined;
  return {
    id: "system.reflection",
    handler: "reflection",
    schedule: {
      kind: "cron",
      expression,
      ...(timezone ? { timezone } : {}),
    },
    catchUp: "run_once",
    initialRun: "now",
  };
}

export async function startServer(): Promise<void> {
  const store = new PhiStore();
  const workspace = store.defaultWorkspace();
  ensureWorkspace(workspace.rootPath);
  const checkpoints = new CheckpointService(store, workspace.rootPath);
  await checkpoints.initialize();
  const { host, port } = serverAddress();
  const mcpTokens = new McpTokenRegistry();
  const harnessCapabilities = new HarnessCapabilityService(workspace.rootPath);
  const messageSearch = createMessageSearch(store, store.rootPath);
  messageSearch.start();
  // PHI_HOP_BUDGET caps consecutive agent-triggered turns per thread; unset
  // or invalid values fall back to the runtime default.
  const hopBudget = Number(process.env.PHI_HOP_BUDGET);
  const runtime = new AgentRuntime(store, workspace.rootPath, {
    mcpPort: port,
    mcpTokens,
    checkpoints,
    ...(Number.isInteger(hopBudget) && hopBudget >= 0 ? { hopBudget } : {}),
  });
  const reflection = new ReflectionService(store, runtime);
  const scheduler = new SchedulerService(store);
  scheduler.registerHandler("reflection", async () => {
    await reflection.runOnce();
  });
  scheduler.upsertTask(reflectionTaskDefinition());
  const subscriptions = new SubscriptionService(store, scheduler, {
    threadAgent: (threadId) => runtime.defaultAgentForThread(threadId),
    onEvent: (message, routedTo) =>
      runtime.handleSystemMessage(message, routedTo),
  });
  scheduler.start();
  const fileHandler = createFileHandler(workspace.rootPath, store);
  const deviceAuth = new DeviceAuth(store.rootPath);
  const attachments = createAttachmentHandlers(store, {
    maxBytes: parseByteLimit(
      process.env.PHI_UPLOAD_MAX_BYTES,
      DEFAULT_UPLOAD_MAX_BYTES,
    ),
  });
  const mcpHandler = createMcpHandler(
    store,
    mcpTokens,
    messageSearch,
    (message, routedTo) => runtime.handleAgentMessage(message, routedTo),
    harnessCapabilities,
    subscriptions,
  );
  runtime.recoverInterruptedTurns();

  let shuttingDown = false;
  const server = Bun.serve({
    hostname: host,
    port,
    development: process.env.NODE_ENV !== "production" && {
      hmr: true,
      console: true,
    },
    routes: haltRoutes({
      "/favicon.ico": () => pngAsset(faviconPng),
      "/favicon.png": () => pngAsset(faviconPng),
      "/apple-touch-icon.png": () => pngAsset(appleTouchIcon),
      "/*": index,
      "/mcp": {
        GET: mcpHandler,
        POST: mcpHandler,
        DELETE: mcpHandler,
      },
      "/api/v1/health": () =>
        Response.json(healthPayload(workspace.id, checkpoints)),
      "/api/v1/settings/git-remote": {
        GET: (req) => {
          const denied = requireDeviceAuth(deviceAuth, req);
          if (denied) return denied;
          return getGitRemoteSettings(store.rootPath, checkpoints);
        },
        PUT: async (req) => {
          const denied = requireDeviceAuth(deviceAuth, req);
          if (denied) return denied;
          return putGitRemoteSettings(req, store.rootPath, checkpoints);
        },
      },
      "/api/v1/auth/session": {
        GET: (req, server) =>
          sessionResponse(deviceAuth, req, isLoopback(req, server)),
      },
      "/api/v1/checkpoints": {
        GET: (req, server) => {
          if (!isLoopback(req, server)) {
            return Response.json({ error: "loopback only" }, { status: 403 });
          }
          return Response.json({ checkpoints: checkpoints.list() });
        },
      },
      "/api/v1/checkpoints/:id/restore": {
        POST: async (req, server) => {
          if (!isLoopback(req, server)) {
            return Response.json({ error: "loopback only" }, { status: 403 });
          }
          const body = (await req.json().catch(() => null)) as {
            scope?: unknown;
            confirm?: unknown;
          } | null;
          const scope = parseRestoreScope(body?.scope);
          if (!scope) {
            return Response.json(
              { error: "scope must be scratch or all" },
              { status: 400 },
            );
          }
          try {
            const result = await runtime.withIdleExclusive(() =>
              checkpoints.restore({
                checkpointId: req.params.id!,
                scope,
                confirm: body?.confirm === true,
              }),
            );
            return Response.json(result);
          } catch (error) {
            if (error instanceof CheckpointBusyError) {
              return Response.json({ error: error.message }, { status: 409 });
            }
            if (error instanceof CheckpointHttpError) {
              return Response.json({ error: error.message }, { status: error.status });
            }
            throw error;
          }
        },
      },
      "/api/v1/channels": () =>
        Response.json({ channels: store.listChannels(workspace.id) }),
      "/api/v1/search": {
        GET: async (req) => {
          const url = new URL(req.url);
          const query = url.searchParams.get("q")?.trim() ?? "";
          if (!query) {
            return Response.json({ error: "q is required" }, { status: 400 });
          }
          const limit = positiveInteger(url.searchParams.get("limit"));
          // The web client searches the whole workspace, so there is no
          // current thread to exclude.
          const result = await messageSearch.search(
            workspace.id,
            { query, includeCurrentThread: true, ...(limit ? { limit } : {}) },
            { currentThreadId: "" },
          );
          return Response.json(result);
        },
      },
      "/api/v1/activity": {
        GET: (req) => {
          const url = new URL(req.url);
          const before = positiveInteger(url.searchParams.get("before"));
          const limit = positiveInteger(url.searchParams.get("limit")) ?? 50;
          return Response.json({
            activity: store.listActivity(workspace.id, {
              before,
              limit: Math.min(limit, 100),
            }),
            waitingCount: store.countWaitingThreads(workspace.id),
          });
        },
      },
      "/api/v1/activity/read": {
        POST: () => {
          store.markAllThreadsRead(workspace.id);
          return Response.json({ ok: true });
        },
      },
      "/api/v1/channels/:id/threads": {
        GET: (req) => {
          if (!store.getChannel(req.params.id!)) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          return Response.json({ threads: store.listThreads(req.params.id!) });
        },
        POST: async (req) => {
          const posted = await parseUserPost(req, store);
          if (!posted.ok) return posted.response;
          if (!store.getChannel(req.params.id!)) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const routing = await runtime.routeUserContent(posted.content);
          const result = store.createThread(req.params.id!, {
            author: "user",
            kind: "message",
            content: posted.content,
            metadata: { ...routing, ...attachmentMeta(posted.attachments) },
          });
          runtime.handleUserMessage(result.message, routing.routedTo);
          return Response.json(result, { status: 201 });
        },
      },
      "/api/v1/threads/:id/messages": {
        GET: (req) => {
          if (!store.getThread(req.params.id!)) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          return Response.json({ messages: store.listMessages(req.params.id!) });
        },
        POST: async (req) => {
          const posted = await parseUserPost(req, store);
          if (!posted.ok) return posted.response;
          const thread = store.getThread(req.params.id!);
          if (!thread) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const routing = await runtime.routeUserContent(
            posted.content,
            thread.id,
          );
          const message = store.appendMessage(req.params.id!, {
            author: "user",
            kind: "message",
            content: posted.content,
            metadata: { ...routing, ...attachmentMeta(posted.attachments) },
          });
          runtime.handleUserMessage(message, routing.routedTo);
          return Response.json({ message }, { status: 201 });
        },
      },
      // Re-runs the thread's last user message after a failed turn (server
      // restart, harness crash). The turn machinery treats it like any other
      // queued turn.
      "/api/v1/threads/:id/retry": {
        POST: async (req) => {
          const thread = store.getThread(req.params.id!);
          if (!thread) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          if (thread.turnActive) {
            return Response.json(
              { error: "a turn is already running" },
              { status: 409 },
            );
          }
          const lastUserMessage = store
            .listMessages(req.params.id!)
            .findLast((message) => message.author === "user");
          if (!lastUserMessage) {
            return Response.json(
              { error: "no user message to retry" },
              { status: 400 },
            );
          }
          runtime.handleUserMessage(lastUserMessage);
          return Response.json({ ok: true }, { status: 202 });
        },
      },
      // Cancels the running turn (ACP session/cancel) and drops work already
      // queued behind it. Idempotent when the thread is idle.
      "/api/v1/threads/:id/cancel": {
        POST: (req) => {
          const thread = store.getThread(req.params.id!);
          if (!thread) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          runtime.cancelTurn(req.params.id!);
          return Response.json({ ok: true }, { status: 202 });
        },
      },
      "/api/v1/threads/:id/read": {
        POST: (req) => {
          if (!store.markThreadRead(req.params.id!)) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          return Response.json({ ok: true });
        },
      },
      "/api/v1/threads/:id": {
        GET: (req) => {
          const thread = store.getThread(req.params.id!);
          if (!thread) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          return Response.json({
            thread,
            anchor:
              thread.kind === "doc_comment"
                ? store.getDocCommentAnchor(thread.id)
                : null,
          });
        },
        PATCH: async (req) => {
          const thread = store.getThread(req.params.id!);
          if (!thread) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const body = (await req.json().catch(() => null)) as {
            status?: unknown;
            outcome?: unknown;
          } | null;
          const status = body?.status;
          const outcome = body?.outcome;
          if (
            status !== undefined &&
            status !== "open" &&
            status !== "settled" &&
            status !== "archived"
          ) {
            return Response.json({ error: "invalid status" }, { status: 400 });
          }
          if (
            outcome !== undefined &&
            outcome !== null &&
            outcome !== "worked" &&
            outcome !== "needed_rework" &&
            outcome !== "user_corrected"
          ) {
            return Response.json({ error: "invalid outcome" }, { status: 400 });
          }
          if (status === undefined && outcome === undefined) {
            return Response.json(
              { error: "status or outcome is required" },
              { status: 400 },
            );
          }
          if (status !== undefined) store.setThreadStatus(thread.id, status);
          const updated =
            outcome !== undefined
              ? store.setThreadOutcome(thread.id, outcome)
              : store.getThread(thread.id);
          return Response.json({ thread: updated });
        },
      },
      "/api/v1/channels/:id/doc-comments/summary": {
        GET: (req) => {
          if (!store.getChannel(req.params.id!)) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const parentThreadId =
            new URL(req.url).searchParams.get("parentThreadId")?.trim() ||
            undefined;
          return Response.json({
            docs: store.listDocCommentSummary(req.params.id!, parentThreadId),
          });
        },
      },
      "/api/v1/channels/:id/doc-comments": {
        GET: (req) => {
          const channelId = req.params.id!;
          if (!store.getChannel(channelId)) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const url = new URL(req.url);
          const rootId = url.searchParams.get("root") ?? "";
          const path = url.searchParams.get("path") ?? "";
          if (!rootId || !path) {
            return Response.json(
              { error: "root and path are required" },
              { status: 400 },
            );
          }
          return Response.json({
            comments: store.listDocComments(channelId, rootId, path),
          });
        },
        POST: async (req) => {
          const channelId = req.params.id!;
          if (!store.getChannel(channelId)) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const body = await req.json().catch(() => null);
          const parsed = parseDocCommentBody(body);
          if (!parsed.ok) {
            return Response.json({ error: parsed.error }, { status: parsed.status });
          }
          const resolved = resolveMarkdownDoc(
            store,
            workspace.rootPath,
            channelId,
            parsed.value.rootId,
            parsed.value.path,
          );
          if (!resolved.ok) {
            return Response.json({ error: resolved.error }, { status: resolved.status });
          }
          const attachments = resolveAttachmentIds(
            store,
            body && typeof body === "object" && !Array.isArray(body)
              ? (body as { attachmentIds?: unknown }).attachmentIds
              : undefined,
          );
          if (!attachments.ok) {
            return Response.json(
              { error: attachments.error },
              { status: attachments.status },
            );
          }
          if (!parsed.value.content && attachments.attachments.length === 0) {
            return Response.json(
              { error: "content or an attachment is required" },
              { status: 400 },
            );
          }
          const parent = resolveDocCommentParent(
            store,
            channelId,
            parsed.value.rootId,
            parsed.value.path,
            parsed.value.parentThreadId,
          );
          if (!parent.ok) {
            return Response.json(
              { error: parent.error },
              { status: parent.status },
            );
          }
          const routing = await runtime.routeUserContent(
            parsed.value.content,
            parent.parentThreadId ?? undefined,
          );
          const result = store.createDocComment(
            channelId,
            {
              author: "user",
              kind: "message",
              content: parsed.value.content,
              metadata: { ...routing, ...attachmentMeta(attachments.attachments) },
            },
            {
              rootId: parsed.value.rootId,
              path: parsed.value.path,
              quote: parsed.value.quote,
              prefix: parsed.value.prefix,
              suffix: parsed.value.suffix,
              headingSlug: parsed.value.headingSlug,
              parentThreadId: parent.parentThreadId,
            },
          );
          runtime.handleUserMessage(result.message, routing.routedTo);
          return Response.json(result, { status: 201 });
        },
      },
      // Read-only file serving for message file links. /files is the
      // managed workspace; channel routes search attached folders too
      // and redirect to an unambiguous file-roots URL.
      "/api/v1/files/*": { GET: fileHandler },
      "/api/v1/channels/:id/files/*": { GET: fileHandler },
      "/api/v1/channels/:id/file-roots/:root/*": { GET: fileHandler },
      // Client uploads. Bytes never go over /ws; ids are server-issued.
      // Require the device bearer (Authorization or phi-device cookie).
      "/api/v1/attachments": {
        POST: async (req) => {
          const denied = requireDeviceAuth(deviceAuth, req);
          if (denied) return denied;
          return attachments.post(req);
        },
      },
      "/api/v1/attachments/:id": {
        GET: async (req) => {
          const denied = requireDeviceAuth(deviceAuth, req);
          if (denied) return denied;
          return attachments.get(req, { id: req.params.id! });
        },
      },
      "/api/v1/attachments/:id/meta": {
        GET: async (req) => {
          const denied = requireDeviceAuth(deviceAuth, req);
          if (denied) return denied;
          return attachments.meta(req, { id: req.params.id! });
        },
      },
      "/api/v1/agents": async () => Response.json(await listAgents(workspace.rootPath)),
      "/api/v1/harnesses": () =>
        Response.json({ harnesses: detectHarnesses() }),
      "/api/v1/harnesses/:id/config": async (req) => {
        const result = await harnessCapabilities.getConfig(req.params.id!);
        return Response.json(result, { status: result.error ? 502 : 200 });
      },
      "/api/v1/agents/:name": {
        GET: async (req) => {
          const agent = await getAgent(workspace.rootPath, req.params.name!);
          if (!agent) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          return Response.json({ agent });
        },
        PUT: async (req) => {
          const body = await req.json().catch(() => null);
          const result = await updateAgent(
            workspace.rootPath,
            req.params.name!,
            body,
          );
          if (!result.ok) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        },
      },
      "/api/v1/setup/status": async () =>
        Response.json(await getSetupStatus(workspace.rootPath)),
      "/api/v1/setup/agent": {
        POST: async (req) => {
          const body = await req.json().catch(() => null);
          const result = await setupDefaultAgent(workspace.rootPath, body);
          if (!result.ok) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        },
      },
    }, () => shuttingDown),
    fetch(req, server) {
      if (shuttingDown) {
        return Response.json({ error: "shutting down" }, { status: 503 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: undefined })) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("deltas");
        const hello: ServerFrame = {
          v: 1,
          type: "hello",
          workspaceId: workspace.id,
          activeTurns: store.listActiveTurns(workspace.id),
        };
        ws.send(JSON.stringify(hello));
      },
      message() {
        // Client -> server commands go over HTTP; the socket is delta-only.
      },
      close(ws) {
        ws.unsubscribe("deltas");
      },
    },
  });

  // Store writes broadcast to every connected client after commit.
  store.onChange = (change) => {
    const frame: ServerFrame = { v: 1, ...change };
    server.publish("deltas", JSON.stringify(frame));
  };

  // Harness subprocesses do not die with the server; kill them explicitly.
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    scheduler.close();
    await server.stop();
    await runtime.shutdown();
    await messageSearch.close().catch((error) => {
      console.error("Failed to close message search", error);
    });
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  console.log(`phi serving on http://${host}:${server.port}`);
}

async function parseUserPost(
  req: Request,
  store: PhiStore,
): Promise<
  | { ok: true; content: string; attachments: Attachment[] }
  | { ok: false; response: Response }
> {
  const body = (await req.json().catch(() => null)) as {
    content?: unknown;
    attachmentIds?: unknown;
  } | null;
  const rawContent = body?.content;
  const content =
    typeof rawContent === "string" ? rawContent.trim() : "";
  const resolved = resolveAttachmentIds(store, body?.attachmentIds);
  if (!resolved.ok) {
    return {
      ok: false,
      response: Response.json({ error: resolved.error }, { status: resolved.status }),
    };
  }
  if (!content && resolved.attachments.length === 0) {
    return {
      ok: false,
      response: Response.json(
        { error: "content or an attachment is required" },
        { status: 400 },
      ),
    };
  }
  return { ok: true, content, attachments: resolved.attachments };
}

function resolveAttachmentIds(
  store: PhiStore,
  raw: unknown,
):
  | { ok: true; attachments: Attachment[] }
  | { ok: false; error: string; status: number } {
  if (raw === undefined) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "attachmentIds must be an array", status: 400 };
  }
  if (raw.length > DEFAULT_UPLOAD_MAX_FILES) {
    return { ok: false, error: "too many attachments", status: 400 };
  }
  const seen = new Set<string>();
  const attachments: Attachment[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || !isAttachmentId(id)) {
      return { ok: false, error: "invalid attachment id", status: 400 };
    }
    if (seen.has(id)) {
      return { ok: false, error: "duplicate attachment id", status: 400 };
    }
    seen.add(id);
    const attachment = store.getAttachment(id);
    if (!attachment) {
      return { ok: false, error: "unknown attachment", status: 400 };
    }
    attachments.push(attachment);
  }
  return { ok: true, attachments };
}

function attachmentMeta(
  attachments: Attachment[],
): { attachments: Attachment[] } | Record<string, never> {
  return attachments.length > 0 ? { attachments } : {};
}

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

function pngAsset(path: string): Response {
  return new Response(Bun.file(path), {
    headers: { "Content-Type": "image/png" },
  });
}

function haltRoutes<T extends NonNullable<Parameters<typeof Bun.serve>[0]["routes"]>>(
  routes: T,
  stopping: () => boolean,
): T {
  const halted: Record<string, unknown> = {};
  const stopped = () =>
    Response.json({ error: "shutting down" }, { status: 503 });
  for (const [path, value] of Object.entries(routes)) {
    if (typeof value === "function") {
      halted[path] = (...args: unknown[]) =>
        stopping() ? stopped() : (value as (...args: unknown[]) => unknown)(...args);
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      const wrapMethods = entries.some(
        ([method, fn]) => HTTP_METHODS.has(method) && typeof fn === "function",
      );
      if (!wrapMethods) {
        halted[path] = value;
        continue;
      }
      const methods: Record<string, unknown> = {};
      for (const [method, fn] of entries) {
        methods[method] =
          typeof fn === "function"
            ? (...args: unknown[]) =>
                stopping() ? stopped() : (fn as (...args: unknown[]) => unknown)(...args)
            : fn;
      }
      halted[path] = methods;
    } else {
      halted[path] = value;
    }
  }
  return halted as T;
}

function isLoopback(
  req: Request,
  server: { requestIP(request: Request): { address: string } | null },
): boolean {
  const address = server.requestIP(req)?.address ?? "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === ":ffff:127.0.0.1"
  );
}

function positiveInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
