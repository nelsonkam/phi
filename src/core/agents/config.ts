import {
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import { connectAcpProcess } from "./acp-process";
import { harnessEntry } from "./harnesses";
import type { HarnessConfig, HarnessConfigOption } from "@/shared/types";

const SESSION_TIMEOUT_MS = 20_000;
// JSON-RPC error code ACP agents use for `auth_required`.
const AUTH_REQUIRED_CODE = -32000;

// Spawns the harness's ACP process, creates a session, and reads the config
// options it advertises (model, effort, fast mode, permission mode, ...).
// The process is killed afterwards either way.
export async function listHarnessConfig(
  harnessId: string,
  cwd: string,
): Promise<HarnessConfig> {
  const entry = harnessEntry(harnessId);
  if (!entry) return { error: `unknown harness "${harnessId}"` };
  if (!entry.acpCommand) {
    return { error: `${entry.name} does not support ACP config listing yet` };
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
    throw new Error(`${entry.name} exited before advertising config options`);
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

    return { options: extractOptions(session) };
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

function extractOptions(session: NewSessionResponse): HarnessConfigOption[] {
  const options: HarnessConfigOption[] = [];

  for (const option of session.configOptions ?? []) {
    const base = {
      id: option.id,
      name: option.name,
      description: option.description ?? null,
      category: option.category ?? null,
    };
    if (option.type === "select") {
      options.push({
        ...base,
        type: "select",
        currentValue: option.currentValue,
        // Select options may be flat values or named groups of values.
        choices: option.options
          .flatMap((choice) => ("options" in choice ? choice.options : [choice]))
          .map((choice) => ({
            value: choice.value,
            name: choice.name,
            description: choice.description ?? null,
          })),
      });
    } else if (option.type === "boolean") {
      options.push({ ...base, type: "boolean", currentValue: option.currentValue });
    }
  }

  return options;
}
