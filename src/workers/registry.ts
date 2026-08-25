import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PhiConfig } from "../config.ts";
import { WorkerAdapterRegistry } from "./adapter.ts";
import { ClaudeWorkerAdapter } from "./claude.ts";
import { CodexWorkerAdapter } from "./codex.ts";
import { CursorWorkerAdapter } from "./cursor.ts";
import { FakeWorkerAdapter } from "./fake.ts";

function credential(path: string, envName: string): string | undefined {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  return process.env[envName];
}

export function buildAdapterRegistry(config: PhiConfig): WorkerAdapterRegistry {
  const isolated = config.credentialMode === "isolated";
  const adapters = new WorkerAdapterRegistry();
  adapters.register(new FakeWorkerAdapter());
  const cursorApiKey = isolated
    ? credential(
        join(config.paths.credentialsDir, "cursor-api-key"),
        "CURSOR_API_KEY",
      )
    : undefined;
  adapters.register(
    new CursorWorkerAdapter({
      stateDir: join(config.paths.workerSessionsDir, "cursor"),
      workspace: config.paths.workspace,
      model: config.cursorModel,
      models: config.cursorModels,
      nativeCredentials: !isolated,
      ...(cursorApiKey ? { apiKey: cursorApiKey } : {}),
    }),
  );
  const claudeApiKey = isolated
    ? credential(
        join(config.paths.credentialsDir, "anthropic-api-key"),
        "ANTHROPIC_API_KEY",
      )
    : undefined;
  adapters.register(
    new ClaudeWorkerAdapter({
      ...(isolated
        ? { configDir: join(config.paths.credentialsDir, "claude") }
        : {}),
      nativeCredentials: !isolated,
      ...(claudeApiKey ? { apiKey: claudeApiKey } : {}),
      ...(config.claudeModel ? { model: config.claudeModel } : {}),
      models: config.claudeModels,
    }),
  );
  const codexApiKey = isolated
    ? credential(
        join(config.paths.credentialsDir, "openai-api-key"),
        "OPENAI_API_KEY",
      )
    : undefined;
  adapters.register(
    new CodexWorkerAdapter({
      ...(isolated
        ? { codexHome: join(config.paths.credentialsDir, "codex") }
        : {}),
      ...(codexApiKey ? { apiKey: codexApiKey } : {}),
      ...(config.codexModel ? { model: config.codexModel } : {}),
      models: config.codexModels,
    }),
  );
  return adapters;
}
