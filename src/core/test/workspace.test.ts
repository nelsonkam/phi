import { expect, test } from "bun:test";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureWorkspace } from "@/core/workspace";
import { tempDir } from "@/testing/tmpdir";

test("seeds the default agent-management skill without overwriting it", () => {
  const root = tempDir();
  const skill = join(
    root,
    ".agents",
    "skills",
    "manage-agents",
    "SKILL.md",
  );

  ensureWorkspace(root);
  const seeded = readFileSync(skill, "utf8");
  expect(seeded).toContain("name: manage-agents");
  expect(seeded).toContain("list_agent_harnesses");

  writeFileSync(skill, "workspace customization\n");
  ensureWorkspace(root);
  expect(readFileSync(skill, "utf8")).toBe("workspace customization\n");
});

test("seeds the default channel-management skill without overwriting it", () => {
  const root = tempDir();
  const skill = join(
    root,
    ".agents",
    "skills",
    "manage-channels",
    "SKILL.md",
  );

  ensureWorkspace(root);
  const seeded = readFileSync(skill, "utf8");
  expect(seeded).toContain("name: manage-channels");
  expect(seeded).toContain("create_channel");

  writeFileSync(skill, "workspace customization\n");
  ensureWorkspace(root);
  expect(readFileSync(skill, "utf8")).toBe("workspace customization\n");
});

test("seeds the workspace AGENTS.md without overwriting it", () => {
  const root = tempDir();
  const guide = join(root, "AGENTS.md");

  ensureWorkspace(root);
  const seeded = readFileSync(guide, "utf8");
  expect(seeded).toContain("phi workspace");
  expect(seeded).toContain("send_message");

  writeFileSync(guide, "workspace customization\n");
  ensureWorkspace(root);
  expect(readFileSync(guide, "utf8")).toBe("workspace customization\n");
});

test("links harness instruction filenames to AGENTS.md without clobbering", () => {
  const root = tempDir();

  ensureWorkspace(root);
  for (const alias of ["CLAUDE.md", "GEMINI.md"]) {
    const link = join(root, alias);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("AGENTS.md");
    expect(readFileSync(link, "utf8")).toContain("phi workspace");
  }

  const claude = join(root, "CLAUDE.md");
  rmSync(claude);
  writeFileSync(claude, "hand-written\n");
  ensureWorkspace(root);
  expect(lstatSync(claude).isSymbolicLink()).toBe(false);
  expect(readFileSync(claude, "utf8")).toBe("hand-written\n");
});
