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
import sandboxWorkspaceGuide from "@/core/workspace-defaults/AGENTS.sandbox.md" with {
  type: "text",
};

const CHANNEL_GUIDE = `# Channel context

This folder holds the durable context and linkable artifacts for this Phi channel.

Before file work, record the relevant repository and worktree paths here, along with the repository-local instruction files that must be read before making changes.
`;

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

export function ensureWorkspace(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  mkdirSync(agentsDir(root), { recursive: true });
  const guide = join(root, "AGENTS.md");
  if (!existsSync(guide)) {
    writeFileSync(
      guide,
      env.PHI_IN_SANDBOX === "1" ? sandboxWorkspaceGuide : workspaceGuide,
    );
  }
  // Claude Code looks for its own instruction filename; a symlink gives it
  // the same guide as Codex and Cursor. Relative targets keep the workspace
  // relocatable, and anything already at the path is left alone.
  for (const alias of ["CLAUDE.md"]) {
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

export function ensureChannelWorkspace(root: string, name: string): void {
  const directory = join(root, "channels", name);
  if (entryExists(directory)) {
    const entry = lstatSync(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(
        `channel path ${JSON.stringify(directory)} must be a real directory`,
      );
    }
  } else {
    mkdirSync(directory, { recursive: true });
  }

  const guide = join(directory, "AGENTS.md");
  if (!entryExists(guide)) writeFileSync(guide, CHANNEL_GUIDE);
}

export function reconcileChannelWorkspaces(
  root: string,
  channelNames: readonly string[],
): void {
  for (const name of channelNames) ensureChannelWorkspace(root, name);
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
