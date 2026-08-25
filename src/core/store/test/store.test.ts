import { test, expect } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@/testing/tmpdir";
import { PhiStore } from "../store";

test("migrates a fresh database and seeds defaults", () => {
  const root = tempDir();
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  expect(workspace.name).toBe("default");
  expect(workspace.rootPath).toBe(join(root, "workspace"));

  const channels = store.listChannels(workspace.id);
  expect(channels.map((c) => c.name)).toEqual(["general"]);
  store.close();
});

test("migrations are idempotent across reopen", () => {
  const root = tempDir();
  new PhiStore(root).close();
  const reopened = new PhiStore(root);
  expect(reopened.listChannels(reopened.defaultWorkspace().id)).toHaveLength(1);
  reopened.close();
});

test("default workspace root follows a moved phi root", () => {
  const oldRoot = tempDir();
  const newRoot = tempDir();
  new PhiStore(oldRoot).close();

  copyFileSync(join(oldRoot, "phi.db"), join(newRoot, "phi.db"));
  const moved = new PhiStore(newRoot);
  expect(moved.defaultWorkspace().rootPath).toBe(join(newRoot, "workspace"));
  moved.close();
});
