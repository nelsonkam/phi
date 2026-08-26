import {
  CLIENT_METHODS,
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import { connectAcpProcess } from "./acp-process";
import { harnessEntry } from "./harnesses";
import type { HarnessModel, HarnessModels } from "@/shared/types";

const SESSION_TIMEOUT_MS = 20_000;
// JSON-RPC error code ACP agents use for `auth_required`.
const AUTH_REQUIRED_CODE = -32000;

// Spawns the harness's ACP process, creates a session, and reads the models
// it advertises. The process is killed afterwards either way.
export async function listHarnessModels(
  harnessId: string,
  cwd: string,
): Promise<HarnessModels> {
  const entry = harnessEntry(harnessId);
  if (!entry) return { error: `unknown harness "${harnessId}"` };
  if (!entry.acpCommand) {
    return { error: `${entry.name} does not support ACP model listing yet` };
  }

  let acp: ReturnType<typeof connectAcpProcess>;
  try {
    acp = connectAcpProcess(entry.acpCommand(), cwd);
  } catch (error) {
    return { error: `failed to start ${entry.name}: ${(error as Error).message}` };
  }
  const { proc, connection } = acp;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${SESSION_TIMEOUT_MS / 1000}s`)),
    SESSION_TIMEOUT_MS,
  );

  // Fail fast if the agent binary dies before finishing the handshake.
  const exited = proc.exited.then(() => {
    throw new Error(`${entry.name} exited before advertising models`);
  });

  try {
    await connection.agent.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      },
      { cancellationSignal: controller.signal },
    );
    const session = (await Promise.race([
      connection.agent.request("session/new", { cwd, mcpServers: [] }, {
        cancellationSignal: controller.signal,
      }),
      exited,
    ])) as NewSessionResponse;

    const models = extractModels(session);
    if (!models) {
      return { error: `${entry.name} does not advertise selectable models` };
    }
    return models;
  } catch (error) {
    if (error instanceof RequestError && error.code === AUTH_REQUIRED_CODE) {
      return {
        error: `${entry.name} is not logged in on this machine`,
        loginHint: entry.loginHint,
      };
    }
    return { error: `${entry.name}: ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
    connection.close();
    proc.kill();
  }
}

// Agents advertise models as a `configOptions` entry with category "model".
function extractModels(
  session: NewSessionResponse,
): { models: HarnessModel[]; currentModelId: string | null } | null {
  const modelOption = session.configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  if (!modelOption || modelOption.type !== "select") return null;

  // Select options may be flat values or named groups of values.
  const flat = modelOption.options.flatMap((option) =>
    "options" in option ? option.options : [option],
  );
  return {
    models: flat.map((option) => ({
      id: option.value,
      name: option.name,
      description: option.description ?? null,
    })),
    currentModelId: modelOption.currentValue,
  };
}
