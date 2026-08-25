import { resolvePaths, type PhiPaths } from "./paths.ts";

export type CredentialMode = "native" | "isolated";

export interface PhiConfig {
  paths: PhiPaths;
  concurrency: number;
  cursorModel: string;
  cursorModels: string[];
  claudeModel?: string;
  claudeModels: string[];
  codexModel?: string;
  codexModels: string[];
  credentialMode: CredentialMode;
  coordinatorModel?: string;
}

function modelList(value: string | undefined, fallback: string[]): string[] {
  const values = value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : fallback;
  return [...new Set(values)];
}

function cursorModels(
  value: string | undefined,
  defaultModel: string,
): string[] {
  const models = modelList(value, [
    "composer-2.5",
    "composer-2",
    "grok-4.6",
    "grok-4.5",
  ]);
  if (![defaultModel, ...models].every((model) => /grok|composer/i.test(model)))
    throw new Error("Cursor models must be Grok or Composer models");
  return [...new Set([defaultModel, ...models])];
}

export function loadConfig(
  options: {
    workspace?: string;
    runtimeDir?: string;
    concurrency?: number;
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
  const cursorModel = process.env.PHI_CURSOR_MODEL ?? "composer-2.5";
  const claudeModel = process.env.PHI_CLAUDE_MODEL;
  const codexModel = process.env.PHI_CODEX_MODEL;
  const config: PhiConfig = {
    paths: resolvePaths(
      options.workspace ?? process.env.PHI_WORKSPACE ?? process.cwd(),
      options.runtimeDir,
    ),
    concurrency,
    cursorModel,
    cursorModels: cursorModels(process.env.PHI_CURSOR_MODELS, cursorModel),
    claudeModels: modelList(process.env.PHI_CLAUDE_MODELS, [
      "haiku",
      "sonnet",
      "opus",
      "fable",
      ...(claudeModel ? [claudeModel] : []),
    ]),
    codexModels: modelList(
      process.env.PHI_CODEX_MODELS,
      codexModel ? [codexModel] : [],
    ),
    credentialMode,
  };
  if (claudeModel) config.claudeModel = claudeModel;
  if (codexModel) config.codexModel = codexModel;
  const coordinatorModel =
    options.coordinatorModel ?? process.env.PHI_COORDINATOR_MODEL;
  if (coordinatorModel) config.coordinatorModel = coordinatorModel;
  return config;
}
