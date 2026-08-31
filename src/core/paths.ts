import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Everything phi owns lives under one root directory. PHI_ROOT overrides it
// for development and tests. Relative values are resolved against cwd so ACP
// session `cwd` (which requires an absolute path) is never `./data`.
export function phiRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PHI_ROOT?.trim();
  return override ? resolve(override) : join(homedir(), ".phi");
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

// Server-owned upload blobs. Outside the managed workspace so they are not
// mixed with attached repositories or git checkpoints.
export function uploadsPath(root: string = phiRoot()): string {
  return join(root, "uploads");
}

// Local device bearer for human clients (browser cookie / native Authorization).
// Distinct from MCP session tokens. 0600 file; hash is what we verify against.
export function deviceTokenPath(root: string = phiRoot()): string {
  return join(root, "device-token");
}
