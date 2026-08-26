import {
  KNOWN_HARNESSES,
  loadAgents,
  loadDefaultAgent,
  writeDefaultAgent,
} from "@/core/agents/registry";
import type { Agent, AgentLoadError } from "@/shared/types";
import { enum as zenum, object, optional, string } from "zod";

// Description and instructions are not user input; writeDefaultAgent applies
// phi's defaults. The user picks the harness and optionally a model.
const SetupAgentSchema = object({
  harness: zenum(KNOWN_HARNESSES),
  model: optional(string().trim().min(1)),
});

export type SetupAgentInput = {
  harness: (typeof KNOWN_HARNESSES)[number];
  model?: string;
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

export type WriteResult =
  | { ok: true }
  | { ok: false; status: 400; error: string };

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

  await writeDefaultAgent(workspaceRoot, result.data);
  return { ok: true };
}
