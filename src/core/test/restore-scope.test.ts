import { expect, test } from "bun:test";
import {
  isAgentsPath,
  parseRestoreScope,
  pathsetForScope,
  scratchPathset,
} from "@/core/restore-scope";

test("classifies the agents set and leaves channel files as scratch", () => {
  expect(isAgentsPath(".agents/agents/grok.md")).toBe(true);
  expect(isAgentsPath(".agents")).toBe(true);
  expect(isAgentsPath("AGENTS.md")).toBe(true);
  expect(isAgentsPath(".gitignore")).toBe(true);
  expect(isAgentsPath("channels/phi/plan.md")).toBe(false);
  expect(isAgentsPath("shared/report.pdf")).toBe(false);
});

test("scratch pathset is the tree union minus agents and .git", () => {
  expect(
    scratchPathset(
      [".agents/agents/a.md", "AGENTS.md", "channels/a.md", ".gitignore"],
      ["channels/a.md", "channels/b.md", "shared/out.txt"],
    ),
  ).toEqual(["channels/a.md", "channels/b.md", "shared/out.txt"]);
});

test("all pathset includes agents files", () => {
  expect(
    pathsetForScope(
      "all",
      [".agents/x.md", "channels/a.md"],
      ["AGENTS.md", "channels/a.md"],
    ),
  ).toEqual([".agents/x.md", "AGENTS.md", "channels/a.md"]);
});

test("parseRestoreScope defaults missing values and rejects unknown scopes", () => {
  expect(parseRestoreScope(undefined)).toBe("scratch");
  expect(parseRestoreScope(null)).toBe("scratch");
  expect(parseRestoreScope("scratch")).toBe("scratch");
  expect(parseRestoreScope("all")).toBe("all");
  expect(parseRestoreScope("agents")).toBeNull();
  expect(parseRestoreScope("")).toBeNull();
  expect(parseRestoreScope(1)).toBeNull();
});
