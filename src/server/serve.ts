import index from "@/web/index.html";
import { PhiStore } from "@/core/store/store";
import { detectHarnesses } from "@/core/agents/harnesses";
import { listHarnessConfig } from "@/core/agents/config";
import type { HarnessConfig } from "@/shared/types";
import { ensureWorkspace } from "@/core/workspace";
import type { ServerFrame } from "@/shared/types";
import {
  getAgent,
  getSetupStatus,
  listAgents,
  setupDefaultAgent,
  updateAgent,
} from "@/server/services/agents";

const DEFAULT_PORT = 3141;
const CONFIG_CACHE_TTL_MS = 5 * 60_000;

// Spawning a harness to ask for its config takes seconds; successful results
// are cached briefly and concurrent requests share one in-flight probe.
const configCache = new Map<
  string,
  { at: number; result: Promise<HarnessConfig> }
>();

function cachedHarnessConfig(
  harnessId: string,
  workspaceRoot: string,
): Promise<HarnessConfig> {
  const cached = configCache.get(harnessId);
  if (cached && Date.now() - cached.at < CONFIG_CACHE_TTL_MS) {
    return cached.result;
  }
  const result = listHarnessConfig(harnessId, workspaceRoot).then((config) => {
    if (config.error) configCache.delete(harnessId);
    return config;
  });
  configCache.set(harnessId, { at: Date.now(), result });
  return result;
}

export function startServer(): void {
  const store = new PhiStore();
  const workspace = store.defaultWorkspace();
  ensureWorkspace(workspace.rootPath);
  const port = Number(process.env.PHI_PORT ?? DEFAULT_PORT);

  const server = Bun.serve({
    port,
    development: process.env.NODE_ENV !== "production" && {
      hmr: true,
      console: true,
    },
    routes: {
      "/*": index,
      "/api/v1/health": () =>
        Response.json({ ok: true, workspaceId: workspace.id }),
      "/api/v1/channels": () =>
        Response.json({ channels: store.listChannels(workspace.id) }),
      "/api/v1/channels/:id/threads": {
        GET: (req) => {
          if (!store.getChannel(req.params.id)) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          return Response.json({ threads: store.listThreads(req.params.id) });
        },
        POST: async (req) => {
          const content = await messageContent(req);
          if (content === null) {
            return Response.json(
              { error: "content is required" },
              { status: 400 },
            );
          }
          if (!store.getChannel(req.params.id)) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const result = store.createThread(req.params.id, {
            author: "user",
            kind: "message",
            content,
          });
          return Response.json(result, { status: 201 });
        },
      },
      "/api/v1/threads/:id/messages": {
        GET: (req) => {
          if (!store.getThread(req.params.id)) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          return Response.json({ messages: store.listMessages(req.params.id) });
        },
        POST: async (req) => {
          const content = await messageContent(req);
          if (content === null) {
            return Response.json(
              { error: "content is required" },
              { status: 400 },
            );
          }
          if (!store.getThread(req.params.id)) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const message = store.appendMessage(req.params.id, {
            author: "user",
            kind: "message",
            content,
          });
          return Response.json({ message }, { status: 201 });
        },
      },
      "/api/v1/agents": async () => Response.json(await listAgents(workspace.rootPath)),
      "/api/v1/harnesses": () =>
        Response.json({ harnesses: detectHarnesses() }),
      "/api/v1/harnesses/:id/config": async (req) => {
        const result = await cachedHarnessConfig(
          req.params.id,
          workspace.rootPath,
        );
        return Response.json(result, { status: result.error ? 502 : 200 });
      },
      "/api/v1/agents/:name": {
        GET: async (req) => {
          const agent = await getAgent(workspace.rootPath, req.params.name);
          if (!agent) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          return Response.json({ agent });
        },
        PUT: async (req) => {
          const body = await req.json().catch(() => null);
          const result = await updateAgent(
            workspace.rootPath,
            req.params.name,
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
    },
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
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

  console.log(`phi serving on http://localhost:${server.port}`);
}

async function messageContent(req: Request): Promise<string | null> {
  const body = (await req.json().catch(() => null)) as {
    content?: unknown;
  } | null;
  const content = body?.content;
  return typeof content === "string" && content.trim().length > 0
    ? content.trim()
    : null;
}
