import { join } from "node:path";
import matter from "gray-matter";
import { strictObject, string } from "zod";
import type { Agent, AgentLoadError } from "@/shared/types";

// Harnesses phi knows how to launch over ACP. Launch commands land with the
// runtime slice; for now the ids gate validation warnings.
export const KNOWN_HARNESSES = ["claude-code", "gemini", "codex"] as const;

export interface AgentDefinition extends Agent {
  instructions: string;
  filePath: string;
}

export interface AgentRegistry {
  agents: AgentDefinition[];
  errors: AgentLoadError[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const FrontmatterSchema = strictObject({
  description: string().trim().min(1).nullish(),
  harness: string().trim().min(1),
  model: string().trim().min(1).nullish(),
});

export function agentsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".agents", "agents");
}

// Reads the registry fresh from disk. Callers hit this per request; the
// directory is small and a watcher can layer on later without API changes.
export async function loadAgents(workspaceRoot: string): Promise<AgentRegistry> {
  const dir = agentsDir(workspaceRoot);

  const agents: AgentDefinition[] = [];
  const errors: AgentLoadError[] = [];
  // A missing directory scans as empty rather than erroring.
  const scan = new Bun.Glob("*.md").scan({ cwd: dir });
  const files = await Array.fromAsync(scan).catch(() => [] as string[]);

  for (const file of files.sort()) {
    const filePath = join(dir, file);
    const name = file.slice(0, -".md".length);
    if (!NAME_PATTERN.test(name)) {
      errors.push({
        file,
        message: "agent filename must be lowercase kebab-case (a-z, 0-9, -)",
      });
      continue;
    }
    const result = parseAgentFile(name, filePath, await Bun.file(filePath).text());
    if (!result.ok) {
      errors.push({ file, message: result.message });
    } else {
      agents.push(result.agent);
    }
  }

  return { agents, errors };
}

function parseAgentFile(
  name: string,
  filePath: string,
  content: string,
): { ok: true; agent: AgentDefinition } | { ok: false; message: string } {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (error) {
    return { ok: false, message: `invalid frontmatter YAML: ${(error as Error).message}` };
  }

  const result = FrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    return { ok: false, message: `frontmatter ${issue.path.join(".")}: ${issue.message}` };
  }

  const warnings: string[] = [];
  if (!(KNOWN_HARNESSES as readonly string[]).includes(result.data.harness)) {
    warnings.push(`unknown harness "${result.data.harness}"`);
  }

  return {
    ok: true,
    agent: {
      name,
      description: result.data.description ?? null,
      harness: result.data.harness,
      model: result.data.model ?? null,
      warnings,
      instructions: parsed.content.trim(),
      filePath,
    },
  };
}
