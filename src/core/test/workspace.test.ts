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
  expect(seeded).toContain("[rules.md](rules.md)");
  expect(readFileSync(join(root, "rules.md"), "utf8")).toContain(
    "Workspace rules and preferences",
  );

  writeFileSync(guide, "workspace customization\n");
  ensureWorkspace(root);
  const customized = readFileSync(guide, "utf8");
  expect(customized).toStartWith("workspace customization\n");
  expect(customized).toContain("[rules.md](rules.md)");
  ensureWorkspace(root);
  expect(readFileSync(guide, "utf8")).toBe(customized);
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
  expect(guide).toContain("[rules.md](rules.md)");
  expect(guide).toContain(".agents/memories/MEMORY.md");
  expect(guide).toContain("channels/<name>/rules.md");
  expect(guide).toContain("channels/<name>/skills/");
  expect(readFileSync(join(root, "rules.md"), "utf8")).toContain(
    "Workspace rules and preferences",
  );

  writeFileSync(join(root, "AGENTS.md"), "custom\n");
  ensureWorkspace(root, { PHI_IN_SANDBOX: "1" });
  const customized = readFileSync(join(root, "AGENTS.md"), "utf8");
  expect(customized).toStartWith("custom\n");
  expect(customized).toContain("[rules.md](rules.md)");
});

test("creates durable channel context without overwriting it", () => {
  const root = tempDir();
  ensureWorkspace(root);
  ensureChannelWorkspace(root, "research");
  const guide = join(root, "channels", "research", "AGENTS.md");
  const seeded = readFileSync(guide, "utf8");
  expect(seeded).toContain("Channel context");
  expect(seeded).toContain("[rules.md](rules.md)");
  expect(seeded).toContain("[skills/](skills/)");
  expect(seeded).not.toContain("/home/agent");

  const rules = join(root, "channels", "research", "rules.md");
  expect(readFileSync(rules, "utf8")).toContain("Channel rules and preferences");
  expect(existsSync(join(root, "channels", "research", "skills"))).toBe(true);

  writeFileSync(guide, "custom context\n");
  ensureChannelWorkspace(root, "research");
  const customized = readFileSync(guide, "utf8");
  expect(customized).toStartWith("custom context\n");
  expect(customized).toContain("[rules.md](rules.md)");
  expect(customized).toContain("[skills/](skills/)");
  ensureChannelWorkspace(root, "research");
  expect(readFileSync(guide, "utf8")).toBe(customized);
});

test("seeds shared memory and preserves workspace customizations", () => {
  const root = tempDir();
  ensureWorkspace(root);
  const index = join(root, ".agents", "memories", "MEMORY.md");
  expect(readFileSync(index, "utf8")).toContain("schema_version: 1");

  writeFileSync(index, "custom memory index\n");
  ensureWorkspace(root);
  expect(readFileSync(index, "utf8")).toBe("custom memory index\n");
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
