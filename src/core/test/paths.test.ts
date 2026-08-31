import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { phiRoot, workspaceRoot } from "@/core/paths";

test("defaults to ~/.phi", () => {
  expect(phiRoot({})).toBe(join(homedir(), ".phi"));
});

test("treats a blank PHI_ROOT as unset", () => {
  expect(phiRoot({ PHI_ROOT: "" })).toBe(join(homedir(), ".phi"));
  expect(phiRoot({ PHI_ROOT: "  " })).toBe(join(homedir(), ".phi"));
});

test("resolves a relative PHI_ROOT so workspace cwd is absolute", () => {
  const root = phiRoot({ PHI_ROOT: "./data" });
  expect(root).toBe(resolve("./data"));
  expect(isAbsolute(root)).toBe(true);
  expect(workspaceRoot(root)).toBe(join(root, "workspace"));
  expect(isAbsolute(workspaceRoot(root))).toBe(true);
});

test("leaves an absolute PHI_ROOT unchanged", () => {
  expect(phiRoot({ PHI_ROOT: "/tmp/phi-root" })).toBe("/tmp/phi-root");
});
