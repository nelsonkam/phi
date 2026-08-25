import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../src/workspace/git.ts";
import { gitRevision, testFixture, type TestFixture } from "./helpers.ts";

let item: TestFixture | null = null;
afterEach(() => {
  item?.database.close();
  item = null;
});

test("Git bootstrap initializes an unversioned workspace and captures a baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "phi-git-bootstrap-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "existing.txt"), "preserve me\n");
  const git = new GitService(workspace);
  const initialized = await git.ensureInitialized();
  expect(initialized.repositoryInitialized).toBeTrue();
  expect(initialized.baselineCreated).toBeTrue();
  expect(await git.currentRevision()).toBe(initialized.revision);
  expect(await git.isRepository()).toBeTrue();
  expect(await git.status()).toBe("");
  const shown = Bun.spawnSync(["git", "show", "HEAD:existing.txt"], {
    cwd: workspace,
    stdout: "pipe",
  });
  expect(shown.exitCode).toBe(0);
  expect(new TextDecoder().decode(shown.stdout)).toBe("preserve me\n");
});

test("Git bootstrap leaves dirty changes in an established repository untouched", async () => {
  item = testFixture();
  const git = new GitService(item.workspace);
  const before = await git.currentRevision();
  if (!before) throw new Error("fixture repository has no revision");
  writeFileSync(join(item.workspace, "uncommitted.txt"), "user change\n");
  const initialized = await git.ensureInitialized();
  expect(initialized).toEqual({
    repositoryInitialized: false,
    baselineCreated: false,
    revision: before,
  });
  expect(await git.status()).toContain("uncommitted.txt");
});

test("Git checkpoints capture global workspace state and replay idempotently", async () => {
  item = testFixture();
  const git = new GitService(item.workspace);
  const before = gitRevision(item.workspace);
  writeFileSync(join(item.workspace, "one.txt"), "worker one\n");
  writeFileSync(join(item.workspace, "two.txt"), "worker two\n");
  const first = await git.checkpoint({
    triggerJobId: "job-one",
    status: "completed",
    checkpointId: "checkpoint-one",
  });
  expect(first.created).toBeTrue();
  expect(first.commit).not.toBe(before);
  expect(await git.status()).toBe("");
  const replay = await git.checkpoint({
    triggerJobId: "job-one",
    status: "completed",
    checkpointId: "checkpoint-one",
  });
  expect(replay).toEqual({
    checkpointId: "checkpoint-one",
    commit: first.commit,
    created: false,
  });
});
