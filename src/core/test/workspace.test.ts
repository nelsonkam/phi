import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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
