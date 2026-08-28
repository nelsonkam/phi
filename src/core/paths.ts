import { homedir } from "node:os";
import { join } from "node:path";

// Everything phi owns lives under one root directory. PHI_ROOT overrides it
// for development and tests.
export function phiRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PHI_ROOT ?? join(homedir(), ".phi");
}

export function dbPath(root: string = phiRoot()): string {
  return join(root, "phi.db");
}

export function workspaceRoot(root: string = phiRoot()): string {
  return join(root, "workspace");
}

export function modelCachePath(root: string = phiRoot()): string {
  return join(root, "models");
}

export function gitRemotePath(root: string = phiRoot()): string {
  return join(root, "git-remote");
}
