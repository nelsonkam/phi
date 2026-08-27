import { join } from "node:path";
import matter from "gray-matter";
import {
  boolean,
  enum as zenum,
  record,
  strictObject,
  string,
  union,
} from "zod";
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
  // Harness session config choices, keyed by the ACP config option id.
  config: record(string(), union([string(), boolean()])).nullish(),
  role: zenum(["default"]).nullish(),
});

export function agentsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".agents", "agents");
}

// The default agent is whichever definition declares `role: default`. Its
// filename remains its handle, so workspaces can give the role a useful name.
// Setup status is "configured" only when such a definition parses cleanly.
export async function loadDefaultAgent(
  workspaceRoot: string,
): Promise<AgentDefinition | null> {
  const { agents } = await loadAgents(workspaceRoot);
  return agents.find((agent) => agent.role === "default") ?? null;
}

export async function loadAgent(
  workspaceRoot: string,
  name: string,
): Promise<AgentDefinition | null> {
  if (name === DEFAULT_AGENT_NAME) return loadDefaultAgent(workspaceRoot);
  const { agents } = await loadAgents(workspaceRoot);
  return agents.find((agent) => agent.name === name) ?? null;
}

// Sensible defaults so setup only needs a harness choice. Users can edit
// default.md afterwards.
export const DEFAULT_AGENT_DESCRIPTION = "Coordinates work across threads";

export const DEFAULT_AGENT_INSTRUCTIONS = `You are the default agent. You coordinate the workspace: break work down, delegate to other agents, and keep the user informed.`;

export interface WriteAgentInput {
  harness: Harness;
  description?: string | null;
  model?: string | null;
  config?: Record<string, string | boolean>;
  instructions: string;
  role?: "default" | null;
}

// Serializes and writes an agent definition, overwriting any existing file.
export async function writeAgent(
  workspaceRoot: string,
  name: string,
  input: WriteAgentInput,
): Promise<void> {
  const frontmatter: Record<string, unknown> = {};
  if (input.role) frontmatter.role = input.role;
  if (input.description) frontmatter.description = input.description;
  frontmatter.harness = input.harness;
  if (input.model) frontmatter.model = input.model;
  if (input.config && Object.keys(input.config).length > 0) {
    frontmatter.config = input.config;
  }

  await Bun.write(
    join(agentsDir(workspaceRoot), `${name}.md`),
    matter.stringify(`\n${input.instructions.trim()}\n`, frontmatter),
  );
}

export interface WriteDefaultAgentInput {
  harness: Harness;
  description?: string;
  model?: string;
  config?: Record<string, string | boolean>;
  instructions?: string;
}

// Writes the default agent. Description and instructions fall back to the
// phi defaults.
export async function writeDefaultAgent(
  workspaceRoot: string,
  input: WriteDefaultAgentInput,
): Promise<void> {
  await writeAgent(workspaceRoot, DEFAULT_AGENT_NAME, {
    role: "default",
    harness: input.harness,
    description: input.description ?? DEFAULT_AGENT_DESCRIPTION,
    model: input.model,
    config: input.config,
    instructions: input.instructions ?? DEFAULT_AGENT_INSTRUCTIONS,
  });
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
      config: result.data.config ?? {},
      role: result.data.role ?? null,
      warnings,
      instructions: parsed.content.trim(),
      filePath,
    },
  };
}
