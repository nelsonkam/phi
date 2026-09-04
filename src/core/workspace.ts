import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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
import manageMcpSkill from "@/core/workspace-defaults/skills/manage-mcp/SKILL.md" with {
  type: "text",
};
import reflectSkill from "@/core/workspace-defaults/skills/reflect/SKILL.md" with {
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

User rules and preferences belong in [rules.md](rules.md), not this harness context file. Channel-specific procedures belong in [skills/](skills/). Read both before acting when they exist.
`;

const CHANNEL_RULES = `# Channel rules and preferences

Durable user-stated rules and preferences for this channel live here. Keep entries small, concrete, and easy to correct. Inferred procedures belong in a reviewed skill under [skills/](skills/) instead.
`;

const WORKSPACE_RULES = `# Workspace rules and preferences

Durable user-stated rules and preferences that apply across channels live here. Keep entries small, concrete, and easy to correct. Channel-only rules belong in that channel's rules.md; inferred procedures belong in a reviewed skill.
`;

const WORKSPACE_REFERENCES = `
## User rules and preferences

- [rules.md](rules.md) — user rules and preferences that apply across this workspace.
`;

const CHANNEL_REFERENCES = `
## Learned rules and procedures

- [rules.md](rules.md) — user rules and preferences for this channel.
- [skills/](skills/) — reviewed procedures scoped to this channel.
`;

const MEMORY_INDEX = `# Shared memory

Harness-neutral workspace memory lives here. Store one fact per Markdown file and link it from this index.

Each fact file starts with frontmatter containing \`schema_version: 1\`, a \`type\` (\`user\`, \`feedback\`, \`project\`, or \`reference\`), a \`scope\` (\`workspace\`, \`channel/<name>\`, or \`agent/<handle>\`), and \`learned_at\`. Update or supersede an existing fact instead of duplicating it.
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
  {
    name: "manage-mcp",
    content: manageMcpSkill,
  },
  {
    name: "reflect",
    content: reflectSkill,
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
  const guideContent = readFileSync(guide, "utf8");
  if (!guideContent.includes("[rules.md](rules.md)")) {
    appendFileSync(guide, WORKSPACE_REFERENCES);
  }
  const rules = join(root, "rules.md");
  if (!entryExists(rules)) writeFileSync(rules, WORKSPACE_RULES);
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
  const memories = join(root, ".agents", "memories");
  mkdirSync(memories, { recursive: true });
  const memoryIndex = join(memories, "MEMORY.md");
  if (!existsSync(memoryIndex)) writeFileSync(memoryIndex, MEMORY_INDEX);
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
  const guideContent = readFileSync(guide, "utf8");
  if (
    !guideContent.includes("[rules.md](rules.md)") ||
    !guideContent.includes("[skills/](skills/)")
  ) {
    appendFileSync(guide, CHANNEL_REFERENCES);
  }
  const rules = join(directory, "rules.md");
  if (!entryExists(rules)) writeFileSync(rules, CHANNEL_RULES);
  mkdirSync(join(directory, "skills"), { recursive: true });
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
