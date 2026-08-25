import { existsSync } from "node:fs";
import { join } from "node:path";
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
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/;

export function agentsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".agents", "agents");
}

// Reads the registry fresh from disk. Callers hit this per request; the
// directory is small and a watcher can layer on later without API changes.
export async function loadAgents(workspaceRoot: string): Promise<AgentRegistry> {
  const dir = agentsDir(workspaceRoot);
  if (!existsSync(dir)) return { agents: [], errors: [] };

  const agents: AgentDefinition[] = [];
  const errors: AgentLoadError[] = [];
  const files = await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: dir }));

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
    if ("message" in result) {
      errors.push({ file, message: result.message });
    } else {
      agents.push(result);
    }
  }

  return { agents, errors };
}

function parseAgentFile(
  name: string,
  filePath: string,
  content: string,
): AgentDefinition | { message: string } {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    return { message: "missing frontmatter (--- block at top of file)" };
  }

  let frontmatter: unknown;
  try {
    frontmatter = Bun.YAML.parse(match[1]!);
  } catch (error) {
    return { message: `invalid frontmatter YAML: ${(error as Error).message}` };
  }
  if (typeof frontmatter !== "object" || frontmatter === null) {
    return { message: "frontmatter must be a YAML mapping" };
  }
  const fields = frontmatter as Record<string, unknown>;

  const harness = fields.harness;
  if (typeof harness !== "string" || harness.length === 0) {
    return { message: "frontmatter requires a `harness` field" };
  }

  const warnings: string[] = [];
  if (!(KNOWN_HARNESSES as readonly string[]).includes(harness)) {
    warnings.push(`unknown harness "${harness}"`);
  }

  return {
    name,
    description: typeof fields.description === "string" ? fields.description : null,
    harness,
    model: typeof fields.model === "string" ? fields.model : null,
    warnings,
    instructions: content.slice(match[0].length).trim(),
    filePath,
  };
}
