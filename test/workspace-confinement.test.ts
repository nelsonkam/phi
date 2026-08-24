import { afterEach, expect, test } from "bun:test";
import { realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confinedWorkspacePath } from "../src/paths.ts";
import { testFixture, type TestFixture } from "./helpers.ts";

let fixture: TestFixture | null = null;
afterEach(() => {
  fixture?.database.close();
  fixture = null;
});

test("coordinator file reads reject lexical and symlink workspace escapes", () => {
  fixture = testFixture();
  const secret = join(fixture.runtime, "secret.txt");
  writeFileSync(secret, "outside\n");
  symlinkSync(secret, join(fixture.workspace, "linked-secret"));
  expect(() =>
    confinedWorkspacePath(fixture!.workspace, "../runtime/secret.txt"),
  ).toThrow("path escapes workspace");
  expect(() =>
    confinedWorkspacePath(fixture!.workspace, "linked-secret"),
  ).toThrow("path escapes workspace");
  expect(confinedWorkspacePath(fixture.workspace, "README.md")).toBe(
    realpathSync(join(fixture.workspace, "README.md")),
  );
});
