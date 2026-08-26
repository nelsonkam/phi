import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentsDir } from "@/core/agents/registry";
import manageAgentsSkill from "@/core/workspace-defaults/skills/manage-agents/SKILL.md" with {
  type: "text",
};

const DEFAULT_SKILLS = [
  {
    name: "manage-agents",
    // Bun's text import is typed as MDX by the ambient Markdown loader.
    content: manageAgentsSkill as unknown as string,
  },
] as const;

export function ensureWorkspace(root: string): void {
  mkdirSync(agentsDir(root), { recursive: true });
  for (const skill of DEFAULT_SKILLS) {
    const dir = join(root, ".agents", "skills", skill.name);
    const file = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, skill.content);
  }
  mkdirSync(join(root, "channels"), { recursive: true });
}
