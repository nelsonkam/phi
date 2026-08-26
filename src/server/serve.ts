import index from "@/web/index.html";
import { PhiStore } from "@/core/store/store";
import { detectHarnesses } from "@/core/agents/harnesses";
import { HarnessCapabilityService } from "@/core/agents/capabilities";
import { AgentRuntime } from "@/core/agents/runtime";
import { ensureWorkspace } from "@/core/workspace";
import type { ServerFrame } from "@/shared/types";
import {
  getAgent,
  getSetupStatus,
  listAgents,
  setupDefaultAgent,
  updateAgent,
} from "@/server/services/agents";
import { createFileHandler } from "@/server/files";
import { createMcpHandler } from "@/server/mcp";
import { McpTokenRegistry } from "@/server/mcp-token-registry";
import { createMessageSearch } from "@/core/search/message-search";

const DEFAULT_PORT = 3141;

export function startServer(): void {
  const store = new PhiStore();
  const workspace = store.defaultWorkspace();
  ensureWorkspace(workspace.rootPath);
  const port = Number(process.env.PHI_PORT ?? DEFAULT_PORT);
  const mcpTokens = new McpTokenRegistry();
  const harnessCapabilities = new HarnessCapabilityService(workspace.rootPath);
  const messageSearch = createMessageSearch(store, store.rootPath);
  messageSearch.start();
  const runtime = new AgentRuntime(store, workspace.rootPath, {
    mcpPort: port,
    mcpTokens,
  });
  const fileHandler = createFileHandler(workspace.rootPath, store);
  const mcpHandler = createMcpHandler(
    store,
    mcpTokens,
    messageSearch,
    (message, routedTo) => runtime.handleAgentMessage(message, routedTo),
    harnessCapabilities,
  );
  runtime.recoverInterruptedTurns();

  const server = Bun.serve({
    port,
    development: process.env.NODE_ENV !== "production" && {
      hmr: true,
      console: true,
    },
    routes: {
      "/*": index,
      "/mcp": {
        GET: mcpHandler,
        POST: mcpHandler,
        DELETE: mcpHandler,
      },
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
          const routing = await runtime.routeUserContent(content);
          const result = store.createThread(req.params.id, {
            author: "user",
            kind: "message",
            content,
            metadata: { ...routing },
          });
          runtime.handleUserMessage(result.message, routing.routedTo[0]);
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
          const routing = await runtime.routeUserContent(
            content,
            req.params.id,
          );
          const message = store.appendMessage(req.params.id, {
            author: "user",
            kind: "message",
            content,
            metadata: { ...routing },
          });
          runtime.handleUserMessage(message, routing.routedTo[0]);
          return Response.json({ message }, { status: 201 });
        },
      },
      // Re-runs the thread's last user message after a failed turn (server
      // restart, harness crash). The turn machinery treats it like any other
      // queued turn.
      "/api/v1/threads/:id/retry": {
        POST: (req) => {
          const thread = store.getThread(req.params.id);
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
            .listMessages(req.params.id)
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
      // Read-only file serving for message file links. /files is the
      // managed workspace; channel routes search attached folders too
      // and redirect to an unambiguous file-roots URL.
      "/api/v1/files/*": { GET: fileHandler },
      "/api/v1/channels/:id/files/*": { GET: fileHandler },
      "/api/v1/channels/:id/file-roots/:root/*": { GET: fileHandler },
      "/api/v1/agents": async () => Response.json(await listAgents(workspace.rootPath)),
      "/api/v1/harnesses": () =>
        Response.json({ harnesses: detectHarnesses() }),
      "/api/v1/harnesses/:id/config": async (req) => {
        const result = await harnessCapabilities.getConfig(req.params.id);
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
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.close();
    await messageSearch.close().catch((error) => {
      console.error("Failed to close message search", error);
    });
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

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
