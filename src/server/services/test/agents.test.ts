import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@/testing/tmpdir";
import { ensureWorkspace } from "@/core/workspace";
import {
  loadAgents,
  loadDefaultAgent,
  writeAgent,
} from "@/core/agents/registry";
import { setupDefaultAgent } from "@/server/services/agents";

function workspace(): string {
  const root = tempDir();
  ensureWorkspace(root);
  return root;
}

test("setupDefaultAgent writes default.md when name is omitted", async () => {
  const root = workspace();
  expect(await setupDefaultAgent(root, { harness: "claude-code" })).toEqual({
    ok: true,
  });
  expect(await loadDefaultAgent(root)).toMatchObject({
    name: "default",
    role: "default",
  });
});

test("setupDefaultAgent writes a named default agent", async () => {
  const root = workspace();
  expect(
    await setupDefaultAgent(root, { name: "grok", harness: "codex" }),
  ).toEqual({ ok: true });

  expect(await loadDefaultAgent(root)).toMatchObject({
    name: "grok",
    role: "default",
    harness: "codex",
  });
  expect(existsSync(join(root, ".agents", "agents", "grok.md"))).toBe(true);
  expect(existsSync(join(root, ".agents", "agents", "default.md"))).toBe(false);
});

test("setupDefaultAgent rejects an invalid name", async () => {
  const result = await setupDefaultAgent(tempDir(), {
    name: "Grok",
    harness: "claude-code",
  });
  expect(result).toMatchObject({ ok: false, status: 400 });
});

test("setupDefaultAgent does not create a second default", async () => {
  const root = workspace();
  await setupDefaultAgent(root, { harness: "claude-code" });
  const second = await setupDefaultAgent(root, {
    name: "grok",
    harness: "codex",
  });
  expect(second).toMatchObject({ ok: false, status: 409 });
  expect(await loadDefaultAgent(root)).toMatchObject({ name: "default" });
  expect(existsSync(join(root, ".agents", "agents", "grok.md"))).toBe(false);
});

test("setupDefaultAgent does not overwrite a peer agent", async () => {
  const root = workspace();
  await writeAgent(root, "grok", {
    harness: "codex",
    instructions: "Keep me.",
  });
  const result = await setupDefaultAgent(root, {
    name: "grok",
    harness: "claude-code",
  });
  expect(result).toMatchObject({ ok: false, status: 409 });
  const { agents } = await loadAgents(root);
  expect(agents.find((agent) => agent.name === "grok")).toMatchObject({
    harness: "codex",
    role: null,
    instructions: "Keep me.",
  });
  expect(await loadDefaultAgent(root)).toBeNull();
});

test("setupDefaultAgent may rewrite the existing default in place", async () => {
  const root = workspace();
  await setupDefaultAgent(root, { name: "grok", harness: "claude-code" });
  expect(
    await setupDefaultAgent(root, { name: "grok", harness: "codex" }),
  ).toEqual({ ok: true });
  expect(await loadDefaultAgent(root)).toMatchObject({
    name: "grok",
    harness: "codex",
  });
});
