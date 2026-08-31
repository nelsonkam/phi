import {
  AGENT_NAME_PATTERN,
  DEFAULT_AGENT_NAME,
  KNOWN_HARNESSES,
  loadAgents,
  loadDefaultAgent,
  writeAgent,
  writeDefaultAgent,
} from "@/core/agents/registry";
import type { Agent, AgentLoadError } from "@/shared/types";
import {
  boolean,
  enum as zenum,
  object,
  optional,
  record,
  string,
  union,
} from "zod";

const ConfigSchema = record(string(), union([string(), boolean()]));

// Description and instructions are not user input; writeDefaultAgent applies
// phi's defaults. The user picks the handle, harness, optionally a model,
// and optionally harness config choices.
const SetupAgentSchema = object({
  name: optional(
    string()
      .trim()
      .min(1)
      .regex(
        AGENT_NAME_PATTERN,
        "must be lowercase kebab-case (a-z, 0-9, -)",
      ),
  ),
  harness: zenum(KNOWN_HARNESSES),
  model: optional(string().trim().min(1)),
  config: optional(ConfigSchema),
});

const UpdateAgentSchema = object({
  harness: zenum(KNOWN_HARNESSES),
  description: optional(string().trim()),
  model: optional(string().trim()),
  config: optional(ConfigSchema),
  instructions: string().trim().min(1),
});

export type SetupAgentInput = {
  name?: string;
  harness: (typeof KNOWN_HARNESSES)[number];
  model?: string;
  config?: Record<string, string | boolean>;
};

export interface AgentList {
  agents: Agent[];
  errors: AgentLoadError[];
}

export async function listAgents(workspaceRoot: string): Promise<AgentList> {
  const { agents, errors } = await loadAgents(workspaceRoot);
  // Instructions and file paths are internal; the wire shape stays small.
  return {
    agents: agents.map(({ instructions, filePath, ...agent }) => agent),
    errors,
  };
}

export async function getSetupStatus(
  workspaceRoot: string,
): Promise<{ configured: boolean }> {
  const agent = await loadDefaultAgent(workspaceRoot);
  return { configured: agent !== null };
}

// The detail view needs the instruction body the list omits.
export async function getAgent(
  workspaceRoot: string,
  name: string,
): Promise<(Agent & { instructions: string }) | null> {
  const { agents } = await loadAgents(workspaceRoot);
  const agent = agents.find((a) => a.name === name);
  if (!agent) return null;
  const { filePath, ...rest } = agent;
  return rest;
}

export type WriteResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; error: string };

export async function updateAgent(
  workspaceRoot: string,
  name: string,
  body: unknown,
): Promise<WriteResult> {
  const result = UpdateAgentSchema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0]!;
    return {
      ok: false,
      status: 400,
      error: `${issue.path.join(".") || "body"}: ${issue.message}`,
    };
  }

  const { agents } = await loadAgents(workspaceRoot);
  const existing = agents.find((a) => a.name === name);
  if (!existing) {
    return { ok: false, status: 404, error: `no agent named "${name}"` };
  }

  await writeAgent(workspaceRoot, name, {
    harness: result.data.harness,
    description: result.data.description || null,
    model: result.data.model || null,
    config: result.data.config,
    instructions: result.data.instructions,
    // The role is not client-editable; whatever the file declared survives.
    role: existing.role,
  });
  return { ok: true };
}

export async function setupDefaultAgent(
  workspaceRoot: string,
  body: unknown,
): Promise<WriteResult> {
  const result = SetupAgentSchema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0]!;
    return {
      ok: false,
      status: 400,
      error: `${issue.path.join(".") || "body"}: ${issue.message}`,
    };
  }

  const name = result.data.name ?? DEFAULT_AGENT_NAME;
  const { agents } = await loadAgents(workspaceRoot);
  const currentDefault = agents.find((agent) => agent.role === "default");
  const existing = agents.find((agent) => agent.name === name);

  if (existing && existing.role !== "default") {
    return {
      ok: false,
      status: 409,
      error: `an agent named "${name}" already exists`,
    };
  }
  if (currentDefault && currentDefault.name !== name) {
    return {
      ok: false,
      status: 409,
      error: `a default agent already exists (@${currentDefault.name})`,
    };
  }

  await writeDefaultAgent(workspaceRoot, { ...result.data, name });
  return { ok: true };
}
