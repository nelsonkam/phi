import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { JobMode } from "../domain.ts";

const primaryFiles = ["agents.md", "system-prompt.md"];

export function loadAgentInstructions(workspace: string): string {
  const root = join(workspace, ".agents");
  if (!existsSync(root) || !statSync(root).isDirectory()) return "";
  const chunks: string[] = [];
  for (const name of primaryFiles) {
    const path = join(root, name);
    if (existsSync(path) && statSync(path).isFile())
      chunks.push(`## .agents/${name}\n\n${readFileSync(path, "utf8")}`);
  }
  const memories = join(root, "memories");
  if (existsSync(memories) && statSync(memories).isDirectory()) {
    for (const entry of readdirSync(memories).sort().slice(0, 32)) {
      const path = join(memories, entry);
      if (statSync(path).isFile())
        chunks.push(
          `## ${relative(workspace, path)}\n\n${readFileSync(path, "utf8")}`,
        );
    }
  }
  return chunks.join("\n\n").slice(0, 256_000);
}

export function buildWorkerBrief(input: {
  workspace: string;
  prompt: string;
  jobId: string;
  dispatchKey: string;
  mode: JobMode;
}): string {
  const instructions = loadAgentInstructions(input.workspace);
  return [
    `Phi delegated job ${input.jobId} (${input.dispatchKey}).`,
    `Mode metadata: ${input.mode}. All workers share this workspace and may run concurrently.`,
    "Work only on the delegated task. Treat existing files and changes as user-owned. Do not commit, reset, clean, rebase, or discard changes.",
    "Other workers may read or write the same files. Re-read before important writes; overlapping writes and last-write-wins behavior are accepted by the host.",
    "The cwd and these instructions are not a security sandbox. Never inspect or modify ~/.phi. Do not communicate directly with the user.",
    "Treat the task as an outcome to achieve, not a claim that any suggested diagnosis is correct. Investigate independently and treat hypotheses as non-binding.",
    "Verify the result in proportion to the task. Report the outcome, verification performed, changed files, limitations, confidence or source caveats, and any needed input succinctly.",
    "Do not expose private chain-of-thought; provide only concise reasoning summaries when useful.",
    instructions
      ? `Workspace protocol instructions:\n\n${instructions}`
      : "No .agents protocol instructions are present.",
    `Task:\n\n${input.prompt}`,
  ].join("\n\n");
}
