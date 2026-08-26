import {
  CLIENT_METHODS,
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { ClientConnection } from "@agentclientprotocol/sdk";

// Spawns an ACP agent subprocess and opens a phi client connection to it.
// The caller owns the process: kill it when done, then close the connection.
export interface AcpProcess {
  proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  connection: ClientConnection;
}

export function connectAcpProcess(
  command: string[],
  cwd: string,
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

  // Permission requests are declined and session updates are ignored: this
  // client never grants anything and never renders agent output itself.
  const connection = client({ name: "phi" })
    .onRequest(CLIENT_METHODS.session_request_permission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .onNotification(CLIENT_METHODS.session_update, () => {})
    .connect(ndJsonStream(writable, proc.stdout));

  return { proc, connection };
}
