import type { ServerFrame } from "@/shared/types";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface DeltaSocketHandlers {
  onFrame: (frame: ServerFrame) => void;
  onStatus: (status: ConnectionStatus) => void;
}

// Minimal delta socket with reconnect. Cursor-based resume comes with the
// messages read model; the shape (status + typed frames) is stable.
export function connectDeltaSocket(handlers: DeltaSocketHandlers): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let retryDelay = 500;

  function open(): void {
    if (closed) return;
    handlers.onStatus("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws`);

    socket.onopen = () => {
      retryDelay = 500;
      handlers.onStatus("connected");
    };
    socket.onmessage = (event) => {
      handlers.onFrame(JSON.parse(event.data) as ServerFrame);
    };
    socket.onclose = () => {
      if (closed) return;
      handlers.onStatus("disconnected");
      setTimeout(open, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10_000);
    };
  }

  open();

  return () => {
    closed = true;
    socket?.close();
  };
}
