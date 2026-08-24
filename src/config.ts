import { resolvePaths, type PhiPaths } from "./paths.ts";

export type CredentialMode = "native" | "isolated";

export interface PhiConfig {
  paths: PhiPaths;
  concurrency: number;
  defaultAdapter: string;
  cursorModel: string;
  credentialMode: CredentialMode;
  coordinatorModel?: string;
}

export function loadConfig(
  options: {
    workspace?: string;
    runtimeDir?: string;
    concurrency?: number;
    adapter?: string;
    credentialMode?: CredentialMode;
    coordinatorModel?: string;
  } = {},
): PhiConfig {
  const concurrency =
    options.concurrency ?? Number(process.env.PHI_CONCURRENCY ?? "4");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
    throw new Error("concurrency must be an integer from 1 to 64");
  const credentialMode =
    options.credentialMode ?? process.env.PHI_CREDENTIAL_MODE ?? "native";
  if (credentialMode !== "native" && credentialMode !== "isolated")
    throw new Error("credential mode must be native or isolated");
  const config: PhiConfig = {
    paths: resolvePaths(
      options.workspace ?? process.env.PHI_WORKSPACE ?? process.cwd(),
      options.runtimeDir,
    ),
    concurrency,
    defaultAdapter: options.adapter ?? process.env.PHI_ADAPTER ?? "fake",
    cursorModel: process.env.PHI_CURSOR_MODEL ?? "composer-2.5",
    credentialMode,
  };
  const coordinatorModel =
    options.coordinatorModel ?? process.env.PHI_COORDINATOR_MODEL;
  if (coordinatorModel) config.coordinatorModel = coordinatorModel;
  return config;
}
