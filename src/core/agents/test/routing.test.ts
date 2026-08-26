import { expect, test } from "bun:test";
import { ensureWorkspace } from "@/core/workspace";
import { writeAgent, writeDefaultAgent } from "@/core/agents/registry";
import { routeAgentContent, routeUserContent } from "@/core/agents/routing";
import { tempDir } from "@/testing/tmpdir";

async function workspaceWithAgents(): Promise<string> {
  const root = tempDir();
  ensureWorkspace(root);
  await writeDefaultAgent(root, { harness: "claude-code" });
  await writeAgent(root, "reviewer", {
    harness: "codex",
    instructions: "Review the work.",
  });
  return root;
}

test("user routing uses only a valid leading mention", async () => {
  const root = await workspaceWithAgents();

  expect(await routeUserContent(root, "  @reviewer check this")).toEqual({
    mentions: ["reviewer"],
    routedTo: ["reviewer"],
  });
  expect(await routeUserContent(root, "ask @reviewer about this")).toEqual({
    mentions: [],
    routedTo: ["default"],
  });
  expect(await routeUserContent(root, "@missing check this")).toEqual({
    mentions: [],
    routedTo: ["default"],
  });
});

test("unmentioned user messages fall back to the thread's agent", async () => {
  const root = await workspaceWithAgents();

  expect(await routeUserContent(root, "keep going", "reviewer")).toEqual({
    mentions: [],
    routedTo: ["reviewer"],
  });
  // A mention still outranks the thread fallback.
  expect(
    await routeUserContent(root, "@default take over", "reviewer"),
  ).toEqual({ mentions: ["default"], routedTo: ["default"] });
  // A stale fallback (agent since deleted) degrades to the workspace default.
  expect(await routeUserContent(root, "keep going", "deleted")).toEqual({
    mentions: [],
    routedTo: ["default"],
  });
});

test("agent routing validates explicit recipients and ignores self-routing", async () => {
  const root = await workspaceWithAgents();

  expect(
    await routeAgentContent(root, "handoff", "default", [
      "reviewer",
      "default",
      "reviewer",
    ]),
  ).toEqual({ mentions: [], routedTo: ["reviewer"] });
  expect(
    await routeAgentContent(root, "@reviewer please continue", "default"),
  ).toEqual({ mentions: ["reviewer"], routedTo: ["reviewer"] });
  await expect(
    routeAgentContent(root, "handoff", "default", ["missing"]),
  ).rejects.toThrow("unknown agent: @missing");
});
