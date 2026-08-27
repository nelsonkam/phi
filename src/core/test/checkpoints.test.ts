import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CheckpointHttpError, CheckpointService } from "@/core/checkpoints";
import { GitWorkspace, runGit } from "@/core/git";
import { PhiStore } from "@/core/store/store";
import { ensureWorkspace } from "@/core/workspace";
import { tempDir } from "@/testing/tmpdir";

function fixture() {
  const root = tempDir("phi-cp-");
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  mkdirSync(workspace.rootPath, { recursive: true });
  ensureWorkspace(workspace.rootPath);
  const checkpoints = new CheckpointService(store, workspace.rootPath);
  return { store, workspace, checkpoints };
}

test("initialize creates a baseline and second call is a no-op", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  expect(checkpoints.health().status).toBe("ok");
  const first = store.listCheckpoints(workspace.id);
  expect(first).toHaveLength(1);
  expect(first[0]?.trigger).toBe("baseline");
  await checkpoints.initialize();
  expect(store.listCheckpoints(workspace.id)).toHaveLength(1);
  store.close();
});

test("startup captures a dirty tree", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  writeFileSync(join(workspace.rootPath, "channels", "x.md"), "x\n");
  const again = new CheckpointService(store, workspace.rootPath);
  await again.initialize();
  const rows = store.listCheckpoints(workspace.id);
  expect(rows[0]?.trigger).toBe("startup");
  store.close();
});

test("recovers a Phi HEAD when the table is empty", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  const original = store.listCheckpoints(workspace.id)[0]!;
  store.db.run("DELETE FROM git_checkpoints");
  const recovered = new CheckpointService(store, workspace.rootPath);
  await recovered.initialize();
  const rows = store.listCheckpoints(workspace.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(original.id);
  expect(rows[0]?.commitSha).toBe(original.commitSha);
  store.close();
});

test("normalizes a stale real index on a Phi-owned repo", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  const git = new GitWorkspace(workspace.rootPath);
  writeFileSync(join(workspace.rootPath, "channels", "n.md"), "n\n");
  await checkpoints.checkpoint({ trigger: "turn" });
  const first = (await runGit(workspace.rootPath, ["rev-parse", "HEAD^"])).stdout.trim();
  await runGit(workspace.rootPath, ["read-tree", first]);
  expect(await git.indexMatchesHead()).toBe(false);
  const again = new CheckpointService(store, workspace.rootPath);
  await again.initialize();
  expect(again.health().status).toBe("ok");
  expect(await git.indexMatchesHead()).toBe(true);
  store.close();
});

test("foreign repo degrades and is not touched", async () => {
  const root = tempDir("phi-cp-");
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  mkdirSync(workspace.rootPath, { recursive: true });
  await runGit(workspace.rootPath, ["init", "-b", "main"]);
  writeFileSync(join(workspace.rootPath, "a.txt"), "a\n");
  await runGit(workspace.rootPath, ["add", "a.txt"]);
  await runGit(workspace.rootPath, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "nope",
  ]);
  const checkpoints = new CheckpointService(store, workspace.rootPath);
  await checkpoints.initialize();
  expect(checkpoints.health().status).toBe("degraded");
  expect(store.listCheckpoints(workspace.id)).toHaveLength(0);
  store.close();
});

test("scratch restore does not rewind agents files", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  writeFileSync(join(workspace.rootPath, "channels", "a.md"), "one\n");
  mkdirSync(join(workspace.rootPath, ".agents"), { recursive: true });
  writeFileSync(join(workspace.rootPath, ".agents", "bot.md"), "v1\n");
  const first = await checkpoints.checkpoint({ trigger: "turn" });
  writeFileSync(join(workspace.rootPath, "channels", "a.md"), "two\n");
  writeFileSync(join(workspace.rootPath, ".agents", "bot.md"), "v2\n");
  await checkpoints.checkpoint({ trigger: "turn" });
  const result = await checkpoints.restore({
    checkpointId: first!.id,
    scope: "scratch",
  });
  expect(result.noop).toBe(false);
  expect(readFileSync(join(workspace.rootPath, "channels", "a.md"), "utf8")).toBe(
    "one\n",
  );
  expect(readFileSync(join(workspace.rootPath, ".agents", "bot.md"), "utf8")).toBe(
    "v2\n",
  );
  store.close();
});

test("restore no-op when mixed tree equals HEAD", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  const current = store.latestCheckpoint(workspace.id)!;
  const result = await checkpoints.restore({
    checkpointId: current.id,
    scope: "scratch",
  });
  expect(result.noop).toBe(true);
  expect(store.listCheckpoints(workspace.id)).toHaveLength(1);
  store.close();
});

test("all restore requires confirm", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  const current = store.latestCheckpoint(workspace.id)!;
  try {
    await checkpoints.restore({ checkpointId: current.id, scope: "all" });
    throw new Error("expected confirm error");
  } catch (error) {
    expect(error).toBeInstanceOf(CheckpointHttpError);
    expect((error as CheckpointHttpError).status).toBe(400);
  }
  store.close();
});

test("git failure during checkpoint degrades health instead of throwing", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  expect(checkpoints.health().status).toBe("ok");
  writeFileSync(join(workspace.rootPath, ".git", "index.lock"), "");
  const row = await checkpoints.checkpoint({ trigger: "turn" });
  expect(row).toBeNull();
  expect(checkpoints.health().status).toBe("degraded");
  expect(checkpoints.health().error).toContain("index lock");
  store.close();
});

test("initialize degrades a hostile rebase instead of throwing", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  mkdirSync(join(workspace.rootPath, ".git", "rebase-merge"));
  const again = new CheckpointService(store, workspace.rootPath);
  await again.initialize();
  expect(again.health().status).toBe("degraded");
  store.close();
});

test("post-initialize reset degrades capture and restore", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  const baseline = store.latestCheckpoint(workspace.id)!;
  writeFileSync(join(workspace.rootPath, "channels", "later.md"), "later\n");
  const second = await checkpoints.checkpoint({ trigger: "turn" });
  expect(second).toBeTruthy();
  await runGit(workspace.rootPath, ["reset", "--hard", baseline.commitSha]);
  expect(await checkpoints.checkpoint({ trigger: "turn" })).toBeNull();
  expect(checkpoints.health().status).toBe("degraded");
  expect(checkpoints.health().error).toContain("ancestor");
  try {
    await checkpoints.restore({ checkpointId: baseline.id, scope: "scratch" });
    throw new Error("expected restore to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CheckpointHttpError);
    expect((error as CheckpointHttpError).status).toBe(503);
  }
  store.close();
});

test("post-initialize rebase degrades restore", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  const current = store.latestCheckpoint(workspace.id)!;
  mkdirSync(join(workspace.rootPath, ".git", "rebase-merge"));
  try {
    await checkpoints.restore({ checkpointId: current.id, scope: "scratch" });
    throw new Error("expected restore to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CheckpointHttpError);
    expect((error as CheckpointHttpError).status).toBe(503);
  }
  expect(checkpoints.health().status).toBe("degraded");
  expect(checkpoints.health().error).toContain("rebase");
  store.close();
});

test("commit-success insert-failure recovers on the next idle checkpoint", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  const original = store.insertCheckpoint.bind(store);
  let failNext = true;
  store.insertCheckpoint = ((input: Parameters<PhiStore["insertCheckpoint"]>[0]) => {
    if (failNext) {
      failNext = false;
      throw new Error("insert failed");
    }
    return original(input);
  }) as PhiStore["insertCheckpoint"];

  writeFileSync(join(workspace.rootPath, "channels", "orphan.md"), "orphan\n");
  expect(await checkpoints.checkpoint({ trigger: "turn" })).toBeNull();
  expect(checkpoints.health().status).toBe("degraded");
  expect(store.listCheckpoints(workspace.id)).toHaveLength(1);

  const git = new GitWorkspace(workspace.rootPath);
  const head = await git.head();
  expect(head).toBeTruthy();
  expect(store.checkpointBySha(head!)).toBeNull();

  expect(await checkpoints.checkpoint({ trigger: "turn" })).toBeNull();
  expect(checkpoints.health().status).toBe("ok");
  expect(store.checkpointBySha(head!)).toBeTruthy();
  expect(store.listCheckpoints(workspace.id)).toHaveLength(2);
  store.close();
});

test("recovered trailers stay in Git order when timestamps tie", async () => {
  const { store, workspace, checkpoints } = fixture();
  await checkpoints.initialize();
  writeFileSync(join(workspace.rootPath, "channels", "a.md"), "a\n");
  await checkpoints.checkpoint({ trigger: "turn" });
  writeFileSync(join(workspace.rootPath, "channels", "a.md"), "b\n");
  const head = await checkpoints.checkpoint({ trigger: "turn" });
  expect(head).toBeTruthy();
  store.db.run("DELETE FROM git_checkpoints");
  const recovered = new CheckpointService(store, workspace.rootPath);
  await recovered.initialize();
  store.db.run(
    "UPDATE git_checkpoints SET created_at = ?",
    ["2026-01-01T00:00:00.000Z"],
  );
  expect(store.latestCheckpoint(workspace.id)?.commitSha).toBe(head!.commitSha);
  expect(store.listCheckpoints(workspace.id)[0]?.commitSha).toBe(head!.commitSha);
  store.close();
});
