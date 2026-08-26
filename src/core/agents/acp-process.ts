import { CLIENT_METHODS, client, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  ClientConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

// Spawns an ACP agent subprocess and opens a phi client connection to it.
// The caller owns the process: kill it when done, then close the connection.
export interface AcpProcess {
  proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  connection: ClientConnection;
}

// Handlers for the agent-initiated half of the protocol. The defaults
// decline every permission and drop session updates, which suits one-shot
// probing; the runtime passes real handlers.
export interface AcpClientHandlers {
  onSessionUpdate?: (notification: SessionNotification) => void;
  onRequestPermission?: (
    request: RequestPermissionRequest,
  ) => RequestPermissionResponse;
}

export function connectAcpProcess(
  command: string[],
  cwd: string,
  handlers: AcpClientHandlers = {},
): AcpProcess {
  // Harness launches are deliberate orchestration: strip the nested-session
  // guard Claude Code sets in terminals it runs in, or a phi dev server
  // started from inside Claude Code could never spawn it.
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  const stdin = proc.stdin;
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      stdin.write(chunk);
    },
    close() {
      stdin.end();
    },
  });

  const connection = client({ name: "phi" })
    .onRequest(
      CLIENT_METHODS.session_request_permission,
      ({ params }) =>
        handlers.onRequestPermission?.(params) ?? {
          outcome: { outcome: "cancelled" },
        },
    )
    .onNotification(CLIENT_METHODS.session_update, ({ params }) => {
      handlers.onSessionUpdate?.(params);
    })
    .connect(ndJsonStream(writable, proc.stdout));

  return { proc, connection };
}
