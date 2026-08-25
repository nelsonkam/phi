import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PhiConfig } from "./config.ts";
import { PhiDatabase } from "./db/database.ts";
import { ensureRuntimeDirectories } from "./paths.ts";
import { GitService } from "./workspace/git.ts";
import { buildAdapterRegistry } from "./workers/registry.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function doctor(config: PhiConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const isolatedCredentials = config.credentialMode === "isolated";
  checks.push({
    name: "bun",
    ok: Bun.version === "1.3.12",
    detail: `Bun ${Bun.version} (validated baseline 1.3.12)`,
  });
  checks.push({
    name: "workspace",
    ok: statSync(config.paths.workspace).isDirectory(),
    detail: config.paths.workspace,
  });
  const git = new GitService(config.paths.workspace);
  const gitInitialization = await git.ensureInitialized();
  checks.push({
    name: "git",
    ok: true,
    detail: gitInitialization.repositoryInitialized
      ? `initialized repository and baseline ${gitInitialization.revision}`
      : gitInitialization.baselineCreated
        ? `created baseline ${gitInitialization.revision}`
        : gitInitialization.revision,
  });
  ensureRuntimeDirectories(config.paths);
  const mode = statSync(config.paths.runtimeDir).mode & 0o777;
  checks.push({
    name: "runtime permissions",
    ok: mode === 0o700,
    detail: `${config.paths.runtimeDir} mode ${mode.toString(8)}`,
  });
  const database = new PhiDatabase(config.paths.database);
  try {
    database.migrate();
    const version = database.raw
      .query("SELECT max(version) AS version FROM schema_migrations")
      .get() as { version: number };
    checks.push({
      name: "sqlite",
      ok: version.version === 2,
      detail: `${config.paths.database}; schema ${version.version}`,
    });
  } finally {
    database.close();
  }
  const adapters = buildAdapterRegistry(config);
  const adapterDescriptions = await adapters.describeAll();
  for (const adapter of adapterDescriptions)
    checks.push({
      name: `adapter ${adapter.id}`,
      ok: true,
      detail: JSON.stringify({
        ...adapter.capabilities,
        defaultModel: adapter.modelCatalog.defaultModel,
        models: adapter.modelCatalog.models.map((model) => model.id),
      }),
    });
  checks.push({
    name: "credential mode",
    ok: true,
    detail: isolatedCredentials
      ? `isolated; SDK configuration and key files use ${config.paths.credentialsDir}`
      : "native; each official SDK resolves its supported user-home authentication",
  });
  if (isolatedCredentials) {
    for (const [name, files, envs] of [
      ["Cursor", ["cursor-api-key"], ["CURSOR_API_KEY"]],
      [
        "Anthropic",
        ["anthropic-api-key"],
        ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      ],
      [
        "OpenAI",
        ["openai-api-key", join("codex", "auth.json")],
        ["OPENAI_API_KEY"],
      ],
    ] as const) {
      const filePath = files
        .map((file) => join(config.paths.credentialsDir, file))
        .find((file) => existsSync(file));
      const env = envs.find((name) => Boolean(process.env[name]));
      const suggestedPath = join(config.paths.credentialsDir, files[0]);
      checks.push({
        name: `${name} credential`,
        ok: Boolean(filePath || env),
        detail: filePath
          ? filePath
          : env
            ? `${env} environment variable`
            : `optional; add ${suggestedPath} with mode 0600`,
      });
    }
  } else {
    for (const [name, id] of [
      ["Cursor credential", "cursor"],
      ["Anthropic credential", "claude"],
      ["OpenAI credential", "codex"],
    ] as const) {
      const descriptor = adapterDescriptions.find(
        (adapter) => adapter.id === id,
      )!;
      checks.push({
        name,
        ok: descriptor.readiness !== "login_required",
        detail: descriptor.detail,
      });
    }
    checks.push({
      name: "Pi credential",
      ok: true,
      detail: "Pi native auth/model stores under the user home",
    });
  }
  checks.push({
    name: ".agents protocol",
    ok: true,
    detail: existsSync(join(config.paths.workspace, ".agents"))
      ? "present"
      : "optional; not present",
  });
  return checks;
}
