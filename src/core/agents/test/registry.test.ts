import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@/testing/tmpdir";
import { loadAgents } from "../registry";

function tempWorkspace(): string {
  const root = tempDir();
  mkdirSync(join(root, ".agents", "agents"), { recursive: true });
  return root;
}

function writeAgent(root: string, file: string, content: string): void {
  writeFileSync(join(root, ".agents", "agents", file), content);
}

test("returns empty registry when the agents directory is missing", async () => {
  expect(await loadAgents(tempDir())).toEqual({ agents: [], errors: [] });
});

test("parses a full agent file", async () => {
  const root = tempWorkspace();
  writeAgent(
    root,
    "architect.md",
    `---
description: Plans things
harness: claude-code
model: claude-opus-5
---

You are the architect.
`,
  );

  const { agents, errors } = await loadAgents(root);
  expect(errors).toEqual([]);
  expect(agents).toHaveLength(1);
  const agent = agents[0]!;
  expect(agent.name).toBe("architect");
  expect(agent.description).toBe("Plans things");
  expect(agent.harness).toBe("claude-code");
  expect(agent.model).toBe("claude-opus-5");
  expect(agent.warnings).toEqual([]);
  expect(agent.instructions).toBe("You are the architect.");
});

test("applies defaults for optional fields", async () => {
  const root = tempWorkspace();
  writeAgent(root, "minimal.md", "---\nharness: gemini\n---\nBody.\n");

  const { agents } = await loadAgents(root);
  expect(agents[0]!.description).toBeNull();
  expect(agents[0]!.model).toBeNull();
});

test("rejects files without a harness or without frontmatter", async () => {
  const root = tempWorkspace();
  writeAgent(root, "no-harness.md", "---\ndescription: x\n---\nBody.\n");
  writeAgent(root, "no-frontmatter.md", "Just a body.\n");

  const { agents, errors } = await loadAgents(root);
  expect(agents).toEqual([]);
  expect(errors.map((e) => e.file).sort()).toEqual([
    "no-frontmatter.md",
    "no-harness.md",
  ]);
});

test("rejects invalid filenames", async () => {
  const root = tempWorkspace();
  writeAgent(root, "Bad Name.md", "---\nharness: codex\n---\n");

  const { agents, errors } = await loadAgents(root);
  expect(agents).toEqual([]);
  expect(errors).toHaveLength(1);
});

test("warns on unknown harness but still lists the agent", async () => {
  const root = tempWorkspace();
  writeAgent(root, "mystery.md", "---\nharness: hal9000\n---\nBody.\n");

  const { agents, errors } = await loadAgents(root);
  expect(errors).toEqual([]);
  expect(agents[0]!.warnings).toEqual(['unknown harness "hal9000"']);
});
