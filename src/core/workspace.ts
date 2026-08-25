import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentsDir } from "@/core/agents/registry";

export function ensureWorkspace(root: string): void {
  mkdirSync(agentsDir(root), { recursive: true });
  mkdirSync(join(root, "channels"), { recursive: true });
  mkdirSync(join(root, "shared"), { recursive: true });
}
