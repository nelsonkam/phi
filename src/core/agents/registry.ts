import { join } from "node:path";
import matter from "gray-matter";
import { enum as zenum, strictObject, string } from "zod";
import type { Agent, AgentLoadError } from "@/shared/types";
import { KNOWN_HARNESSES } from "./harnesses";

export { KNOWN_HARNESSES } from "./harnesses";

export type Harness = (typeof KNOWN_HARNESSES)[number];

export const DEFAULT_AGENT_NAME = "default";

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
  role: zenum(["default"]).nullish(),
});

export function agentsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".agents", "agents");
}

// The default agent (the old coordinator) is the file `default.md`. Setup
// status is "configured" only when that file exists and parses cleanly.
export async function loadDefaultAgent(
  workspaceRoot: string,
): Promise<AgentDefinition | null> {
  const filePath = join(agentsDir(workspaceRoot), `${DEFAULT_AGENT_NAME}.md`);
  const content = await Bun.file(filePath)
    .text()
    .catch(() => null);
  if (content === null) return null;

  const result = parseAgentFile(DEFAULT_AGENT_NAME, filePath, content);
  return result.ok && result.agent.role === "default" ? result.agent : null;
}

// Sensible defaults so setup only needs a harness choice. Users can edit
// default.md afterwards.
export const DEFAULT_AGENT_DESCRIPTION = "Coordinates work across threads";

export const DEFAULT_AGENT_INSTRUCTIONS = `You are the default agent. You coordinate the workspace: break work down, delegate to other agents, and keep the user informed.`;

export interface WriteDefaultAgentInput {
  harness: Harness;
  description?: string;
  model?: string;
  instructions?: string;
}

// Serializes and writes the default agent definition. Overwrites any existing
// default.md. Description and instructions fall back to the phi defaults.
export async function writeDefaultAgent(
  workspaceRoot: string,
  input: WriteDefaultAgentInput,
): Promise<void> {
  const description = input.description ?? DEFAULT_AGENT_DESCRIPTION;
  const instructions = input.instructions ?? DEFAULT_AGENT_INSTRUCTIONS;

  const frontmatter = [
    "---",
    "role: default",
    `description: ${JSON.stringify(description)}`,
    `harness: ${input.harness}`,
    input.model ? `model: ${input.model}` : null,
    "---",
  ]
    .filter((line) => line !== null)
    .join("\n");

  await Bun.write(
    join(agentsDir(workspaceRoot), `${DEFAULT_AGENT_NAME}.md`),
    `${frontmatter}\n\n${instructions.trim()}\n`,
  );
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
      role: result.data.role ?? null,
      warnings,
      instructions: parsed.content.trim(),
      filePath,
    },
  };
}
