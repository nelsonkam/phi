import { expect, test } from "bun:test";
import { ensureWorkspace } from "@/core/workspace";
import { writeAgent, writeDefaultAgent } from "@/core/agents/registry";
import {
  ExplicitRecipientRequiredError,
  routeAgentContent,
  routeUserContent,
  stripLeadingMention,
  unroutedPeerMentions,
} from "@/core/agents/routing";
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

test("a leading mention is the primary addressee", async () => {
  const root = await workspaceWithAgents();

  expect(await routeUserContent(root, "  @reviewer check this")).toEqual({
    mentions: ["reviewer"],
    routedTo: ["reviewer"],
  });
  expect(await routeUserContent(root, "@missing check this")).toEqual({
    mentions: [],
    routedTo: ["default"],
  });
  expect(await routeUserContent(root, "@reviewer: check this")).toEqual({
    mentions: ["reviewer"],
    routedTo: ["reviewer"],
  });
});

test("a mid-body mention wakes that agent speculatively", async () => {
  const root = await workspaceWithAgents();

  // The primary (fallback) still leads; the mentioned agent rides along.
  expect(await routeUserContent(root, "ask @reviewer about this")).toEqual({
    mentions: ["reviewer"],
    routedTo: ["default", "reviewer"],
    speculative: ["reviewer"],
  });
  // Leading primary plus a mid-body peer, deduplicated.
  expect(
    await routeUserContent(
      root,
      "@reviewer check this, then loop in @default and @reviewer",
    ),
  ).toEqual({
    mentions: ["reviewer", "default"],
    routedTo: ["reviewer", "default"],
    speculative: ["default"],
  });
  // A mid-body mention of the primary itself is not speculative.
  expect(
    await routeUserContent(root, "keep going, and yes @default I mean you"),
  ).toEqual({
    mentions: ["default"],
    routedTo: ["default"],
  });
  // Unknown handles stay inert wherever they appear.
  expect(await routeUserContent(root, "ask @missing about this")).toEqual({
    mentions: [],
    routedTo: ["default"],
  });
});

test("stripLeadingMention removes only address-shaped routing text", () => {
  expect(stripLeadingMention("@reviewer inspect this", "reviewer")).toBe(
    "inspect this",
  );
  expect(stripLeadingMention("  @reviewer, inspect this", "reviewer")).toBe(
    "inspect this",
  );
  expect(stripLeadingMention("@reviewer: inspect this", "reviewer")).toBe(
    "inspect this",
  );
  // Possessives (straight and curly) are content, not addressing.
  expect(stripLeadingMention("@reviewer's notes", "reviewer")).toBe(
    "@reviewer's notes",
  );
  expect(stripLeadingMention("@reviewer’s notes", "reviewer")).toBe(
    "@reviewer’s notes",
  );
  // Another handle, or a mention-only message, stays intact.
  expect(stripLeadingMention("@other inspect this", "reviewer")).toBe(
    "@other inspect this",
  );
  expect(stripLeadingMention("@reviewer", "reviewer")).toBe("@reviewer");
});

test("a possessive leading handle is prose, not an address", async () => {
  const root = await workspaceWithAgents();

  expect(await routeUserContent(root, "@reviewer’s notes look right")).toEqual({
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
  await expect(
    routeAgentContent(root, "handoff", "default", ["missing"]),
  ).rejects.toThrow("unknown agent: @missing");
});

test("agent content never routes; only `to` does", async () => {
  const root = await workspaceWithAgents();

  // A leading mention without `to` is display metadata, not a route.
  expect(
    await routeAgentContent(root, "@reviewer please continue", "default"),
  ).toEqual({ mentions: ["reviewer"], routedTo: [] });
  // With `to`, the leading mention stays display-only alongside the route.
  expect(
    await routeAgentContent(root, "@reviewer please continue", "default", [
      "reviewer",
    ]),
  ).toEqual({ mentions: ["reviewer"], routedTo: ["reviewer"] });
});

test("unroutedPeerMentions finds address-shaped known peers anywhere", async () => {
  const root = await workspaceWithAgents();

  // Mid-body, leading, punctuation-adjacent, and bracketed shapes all count.
  expect(
    await unroutedPeerMentions(root, "done — @reviewer should look.", "default"),
  ).toEqual(["reviewer"]);
  expect(
    await unroutedPeerMentions(root, "@reviewer please continue", "default"),
  ).toEqual(["reviewer"]);
  expect(
    await unroutedPeerMentions(root, "ping @reviewer, then (@default)", "worker"),
  ).toEqual(["reviewer", "default"]);
  // Duplicates collapse.
  expect(
    await unroutedPeerMentions(root, "@reviewer and @reviewer again", "default"),
  ).toEqual(["reviewer"]);
});

test("unroutedPeerMentions ignores prose shapes, self, and unknowns", async () => {
  const root = await workspaceWithAgents();

  // Possessives (straight and curly) and emails are prose.
  expect(
    await unroutedPeerMentions(root, "@reviewer's pass is clean", "default"),
  ).toEqual([]);
  expect(
    await unroutedPeerMentions(root, "@reviewer’s pass is clean", "default"),
  ).toEqual([]);
  expect(
    await unroutedPeerMentions(root, "mail reviewer@example.com", "default"),
  ).toEqual([]);
  // The author's own handle and unknown handles never warn.
  expect(
    await unroutedPeerMentions(root, "@reviewer here, done", "reviewer"),
  ).toEqual([]);
  expect(
    await unroutedPeerMentions(root, "ask @missing for a pass", "default"),
  ).toEqual([]);
});

test("send-path routing rejects a leading handle without `to`", async () => {
  const root = await workspaceWithAgents();
  const strict = { requireExplicitHandoff: true };

  const rejection = routeAgentContent(
    root,
    "@reviewer please continue",
    "default",
    undefined,
    strict,
  );
  await expect(rejection).rejects.toBeInstanceOf(
    ExplicitRecipientRequiredError,
  );
  await expect(rejection).rejects.toThrow("EXPLICIT_RECIPIENT_REQUIRED");

  // Prose forms pass: a possessive, a mid-body mention, an unknown handle,
  // and the author's own handle.
  expect(
    await routeAgentContent(
      root,
      "@reviewer’s re-check is clean",
      "default",
      undefined,
      strict,
    ),
  ).toEqual({ mentions: [], routedTo: [] });
  expect(
    await routeAgentContent(
      root,
      "ask @reviewer for a pass",
      "default",
      undefined,
      strict,
    ),
  ).toEqual({ mentions: [], routedTo: [] });
  expect(
    await routeAgentContent(root, "@missing ping", "default", undefined, strict),
  ).toEqual({ mentions: [], routedTo: [] });
  expect(
    await routeAgentContent(
      root,
      "@reviewer here, done",
      "reviewer",
      undefined,
      strict,
    ),
  ).toEqual({ mentions: ["reviewer"], routedTo: [] });
});
