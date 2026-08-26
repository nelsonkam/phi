import index from "@/web/index.html";
import { PhiStore } from "@/core/store/store";
import { detectHarnesses } from "@/core/agents/harnesses";
import { listHarnessModels } from "@/core/agents/models";
import type { HarnessModels } from "@/shared/types";
import { ensureWorkspace } from "@/core/workspace";
import type { ServerFrame } from "@/shared/types";
import {
  getSetupStatus,
  listAgents,
  setupDefaultAgent,
} from "@/server/services/agents";

const DEFAULT_PORT = 3141;
const MODELS_CACHE_TTL_MS = 5 * 60_000;

// Spawning a harness to ask for its models takes seconds; successful results
// are cached briefly and concurrent requests share one in-flight probe.
const modelsCache = new Map<
  string,
  { at: number; result: Promise<HarnessModels> }
>();

function cachedHarnessModels(
  harnessId: string,
  workspaceRoot: string,
): Promise<HarnessModels> {
  const cached = modelsCache.get(harnessId);
  if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) {
    return cached.result;
  }
  const result = listHarnessModels(harnessId, workspaceRoot).then((models) => {
    if (models.error) modelsCache.delete(harnessId);
    return models;
  });
  modelsCache.set(harnessId, { at: Date.now(), result });
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
      "/api/v1/agents": async () => Response.json(await listAgents(workspace.rootPath)),
      "/api/v1/harnesses": () =>
        Response.json({ harnesses: detectHarnesses() }),
      "/api/v1/harnesses/:id/models": async (req) => {
        const result = await cachedHarnessModels(
          req.params.id,
          workspace.rootPath,
        );
        return Response.json(result, { status: result.error ? 502 : 200 });
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

  console.log(`phi serving on http://localhost:${server.port}`);
}
