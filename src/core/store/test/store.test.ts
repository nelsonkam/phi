import { test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { PhiStore } from "@/core/store/store";

const dir = mkdtempSync(join(tmpdir(), "phi-store-test-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tempStore(): PhiStore {
  return new PhiStore(join(dir, `${crypto.randomUUID()}.db`));
}

test("migrates a fresh database and seeds defaults", () => {
  const store = tempStore();
  const workspace = store.defaultWorkspace();
  expect(workspace.name).toBe("default");

  const channels = store.listChannels(workspace.id);
  expect(channels.map((c) => c.name)).toEqual(["general"]);
  store.close();
});

test("migrations are idempotent across reopen", () => {
  const path = join(dir, `${crypto.randomUUID()}.db`);
  new PhiStore(path).close();
  const reopened = new PhiStore(path);
  expect(reopened.listChannels(reopened.defaultWorkspace().id)).toHaveLength(1);
  reopened.close();
});
