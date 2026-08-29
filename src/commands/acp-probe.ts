import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { connectAcpProcess } from "@/core/agents/acp-process";
import {
  acpClientCapabilities,
  configuredHarnesses,
  harnessEntry,
} from "@/core/agents/harnesses";

const PROBE_TIMEOUT_MS = 30_000;

export async function runAcpProbe(): Promise<void> {
  for (const harnessId of configuredHarnesses()) {
    const command = harnessEntry(harnessId)?.acpCommand?.();
    if (!command) throw new Error(`no ACP command for ${harnessId}`);
    const acp = connectAcpProcess(command, process.cwd(), {
      onSessionUpdate: () => undefined,
      onRequestPermission: () => ({ outcome: { outcome: "cancelled" } }),
    });
    const controller = new AbortController();
    let rejectTimeout: ((error: Error) => void) | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      const error = new Error(`${harnessId} ACP probe timed out`);
      controller.abort(error);
      rejectTimeout?.(error);
    }, PROBE_TIMEOUT_MS);
    try {
      await Promise.race([
        acp.connection.agent.request(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: acpClientCapabilities(harnessId),
          },
          { cancellationSignal: controller.signal },
        ),
        timedOut,
      ]);
      console.log(`${harnessId} ACP handshake completed`);
    } finally {
      clearTimeout(timer);
      acp.connection.close();
      acp.proc.kill();
    }
  }
}
