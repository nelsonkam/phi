import type { RestoreScope } from "@/shared/types";

export type { RestoreScope };

export function parseRestoreScope(value: unknown): RestoreScope | null {
  if (value === undefined || value === null) return "scratch";
  if (value === "scratch" || value === "all") return value;
  return null;
}

const AGENT_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  // Historical compatibility: old workspaces/checkpoints may still own it.
  "GEMINI.md",
  ".gitignore",
]);

export function isAgentsPath(path: string): boolean {
  if (path === ".git" || path === ".git/" || path.startsWith(".git/")) {
    return false;
  }
  if (path === ".agents" || path.startsWith(".agents/")) return true;
  return AGENT_FILES.has(path);
}

export function isGitPath(path: string): boolean {
  return path === ".git" || path.startsWith(".git/");
}

export function scratchPathset(
  headPaths: readonly string[],
  sourcePaths: readonly string[],
): string[] {
  const union = new Set<string>();
  for (const path of headPaths) union.add(path);
  for (const path of sourcePaths) union.add(path);
  return [...union]
    .filter((path) => !isGitPath(path) && !isAgentsPath(path))
    .sort();
}

export function allPathset(
  headPaths: readonly string[],
  sourcePaths: readonly string[],
): string[] {
  const union = new Set<string>();
  for (const path of headPaths) union.add(path);
  for (const path of sourcePaths) union.add(path);
  return [...union].filter((path) => !isGitPath(path)).sort();
}

export function pathsetForScope(
  scope: RestoreScope,
  headPaths: readonly string[],
  sourcePaths: readonly string[],
): string[] {
  return scope === "all"
    ? allPathset(headPaths, sourcePaths)
    : scratchPathset(headPaths, sourcePaths);
}
