import index from "@/web/index.html";
import { PhiStore } from "@/core/store/store";
import type { ServerFrame } from "@/shared/types";

const DEFAULT_PORT = 3141;

export function startServer(): void {
  const store = new PhiStore();
  const workspace = store.defaultWorkspace();
  const port = Number(process.env.PHI_PORT ?? DEFAULT_PORT);

  const server = Bun.serve({
    port,
    development: process.env.NODE_ENV !== "production" && {
      hmr: true,
      console: true,
    },
    routes: {
      "/": index,
      "/api/v1/health": () =>
        Response.json({ ok: true, workspaceId: workspace.id }),
      "/api/v1/channels": () =>
        Response.json({ channels: store.listChannels(workspace.id) }),
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
