import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ensureChannelWorkspace,
  ensureWorkspace,
} from "@/core/workspace";
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
  for (const alias of ["CLAUDE.md"]) {
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
  expect(existsSync(join(root, "GEMINI.md"))).toBe(false);
});

test("preserves a historical GEMINI.md without creating new ones", () => {
  const root = tempDir();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "GEMINI.md"), "historical\n");
  ensureWorkspace(root);
  expect(readFileSync(join(root, "GEMINI.md"), "utf8")).toBe("historical\n");
});

test("uses the sandbox topology guide only for a new sandbox workspace", () => {
  const root = tempDir();
  ensureWorkspace(root, { PHI_IN_SANDBOX: "1" });
  const guide = readFileSync(join(root, "AGENTS.md"), "utf8");
  expect(guide).toContain("/home/agent/work/repos");
  expect(guide).toContain("isolated Docker Engine");
  expect(guide).toContain("`sbx rm`");

  writeFileSync(join(root, "AGENTS.md"), "custom\n");
  ensureWorkspace(root, { PHI_IN_SANDBOX: "1" });
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("custom\n");
});

test("creates durable channel context without overwriting it", () => {
  const root = tempDir();
  ensureWorkspace(root);
  ensureChannelWorkspace(root, "research");
  const guide = join(root, "channels", "research", "AGENTS.md");
  const seeded = readFileSync(guide, "utf8");
  expect(seeded).toContain("Channel context");
  expect(seeded).not.toContain("/home/agent");

  writeFileSync(guide, "custom context\n");
  ensureChannelWorkspace(root, "research");
  expect(readFileSync(guide, "utf8")).toBe("custom context\n");
});

test("rejects a channel path that is not a real directory", () => {
  const root = tempDir();
  mkdirSync(join(root, "channels"), { recursive: true });
  writeFileSync(join(root, "channels", "blocked"), "not a directory\n");
  expect(() => ensureChannelWorkspace(root, "blocked")).toThrow(
    "must be a real directory",
  );
});

test("rejects a symlink at the channel path", () => {
  const root = tempDir();
  const target = tempDir();
  mkdirSync(join(root, "channels"), { recursive: true });
  symlinkSync(target, join(root, "channels", "linked"), "dir");
  expect(() => ensureChannelWorkspace(root, "linked")).toThrow(
    "must be a real directory",
  );
});
