import {
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { agentsDir } from "@/core/agents/registry";
import manageAgentsSkill from "@/core/workspace-defaults/skills/manage-agents/SKILL.md" with {
  type: "text",
};
import manageChannelsSkill from "@/core/workspace-defaults/skills/manage-channels/SKILL.md" with {
  type: "text",
};
import workspaceGuide from "@/core/workspace-defaults/AGENTS.md" with {
  type: "text",
};

const DEFAULT_SKILLS = [
  {
    name: "manage-agents",
    content: manageAgentsSkill,
  },
  {
    name: "manage-channels",
    content: manageChannelsSkill,
  },
] as const;

export function ensureWorkspace(root: string): void {
  mkdirSync(agentsDir(root), { recursive: true });
  const guide = join(root, "AGENTS.md");
  if (!existsSync(guide)) {
    writeFileSync(guide, workspaceGuide);
  }
  // Claude Code and Gemini CLI look for their own instruction filenames;
  // symlinks give every harness the same guide. Relative targets keep the
  // workspace relocatable, and anything already at the path is left alone.
  for (const alias of ["CLAUDE.md", "GEMINI.md"]) {
    // lstat instead of exists: a dangling symlink must count as present.
    if (!entryExists(join(root, alias))) {
      symlinkSync("AGENTS.md", join(root, alias));
    }
  }
  for (const skill of DEFAULT_SKILLS) {
    const dir = join(root, ".agents", "skills", skill.name);
    const file = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, skill.content);
  }
  mkdirSync(join(root, "channels"), { recursive: true });
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
