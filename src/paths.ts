import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export interface PhiPaths {
  workspace: string;
  runtimeDir: string;
  database: string;
  credentialsDir: string;
  sessionsDir: string;
  coordinatorSessionsDir: string;
  workerSessionsDir: string;
  logsDir: string;
  tmpDir: string;
}

export function resolvePaths(
  workspaceInput: string,
  runtimeInput?: string,
): PhiPaths {
  const workspace = realpathSync(resolve(workspaceInput));
  const runtimeDir = resolve(
    runtimeInput ?? process.env.PHI_HOME ?? join(homedir(), ".phi"),
  );
  if (
    workspace === runtimeDir ||
    workspace.startsWith(`${runtimeDir}${sep}`) ||
    runtimeDir.startsWith(`${workspace}${sep}`)
  ) {
    throw new Error(
      "Phi runtime and managed workspace must be separate directories",
    );
  }
  return {
    workspace,
    runtimeDir,
    database: join(runtimeDir, "runtime.db"),
    credentialsDir: join(runtimeDir, "credentials"),
    sessionsDir: join(runtimeDir, "sessions"),
    coordinatorSessionsDir: join(runtimeDir, "sessions", "coordinator"),
    workerSessionsDir: join(runtimeDir, "sessions", "workers"),
    logsDir: join(runtimeDir, "logs"),
    tmpDir: join(runtimeDir, "tmp"),
  };
}

export function ensureRuntimeDirectories(paths: PhiPaths): void {
  for (const path of [
    paths.runtimeDir,
    paths.credentialsDir,
    paths.sessionsDir,
    paths.coordinatorSessionsDir,
    paths.workerSessionsDir,
    paths.logsDir,
    paths.tmpDir,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
}

export function confinedWorkspacePath(
  workspace: string,
  input: string,
): string {
  const root = realpathSync(workspace);
  const candidate = realpathSync(resolve(root, input));
  if (
    !isAbsolute(candidate) ||
    (candidate !== root && !candidate.startsWith(`${root}${sep}`))
  ) {
    throw new Error(`path escapes workspace: ${input}`);
  }
  return candidate;
}
