import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CheckpointHttpError, CheckpointService } from "@/core/checkpoints";
import { GitWorkspace, runGit } from "@/core/git";
import { gitRemotePath } from "@/core/paths";
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

function gitOf(checkpoints: CheckpointService): GitWorkspace {
  return (checkpoints as unknown as { git: GitWorkspace }).git;
}

async function remoteFixture() {
  const root = tempDir("phi-cp-");
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  mkdirSync(workspace.rootPath, { recursive: true });
  ensureWorkspace(workspace.rootPath);
  const bare = tempDir("phi-bare-");
  await runGit(bare, ["init", "--bare", "-b", "main"]);
  writeFileSync(gitRemotePath(root), `file://${bare}\n`);
  const checkpoints = new CheckpointService(store, workspace.rootPath);
  return { store, workspace, checkpoints, bare };
}

test("push after checkpoint updates a file remote", async () => {
  const { store, workspace, checkpoints, bare } = await remoteFixture();
  await checkpoints.initialize();
  await checkpoints.flushRemote();
  expect(checkpoints.remoteHealth().status).toBe("ok");
  expect(checkpoints.health().status).toBe("ok");
  const head = store.latestCheckpoint(workspace.id)!.commitSha;
  const remoteHead = (await runGit(bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
  expect(remoteHead).toBe(head!);
  store.close();
});

test("health is pending until the first push settles", async () => {
  const { store, checkpoints } = await remoteFixture();
  const git = gitOf(checkpoints);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = git.pushSha.bind(git);
  git.pushSha = async (sha, options) => {
    await blocked;
    return original(sha, options);
  };
  await checkpoints.initialize();
  expect(checkpoints.health().status).toBe("ok");
  expect(checkpoints.remoteHealth().status).toBe("pending");
  expect(checkpoints.remoteHealth().configured).toBe(true);
  expect(checkpoints.remoteHealth().displayUrl).toBeNull();
  release();
  await checkpoints.flushRemote();
  expect(checkpoints.remoteHealth().status).toBe("ok");
  store.close();
});

test("flush does not wait for a delayed push", async () => {
  const { store, checkpoints } = await remoteFixture();
  const git = gitOf(checkpoints);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = git.pushSha.bind(git);
  git.pushSha = async (sha, options) => {
    await blocked;
    return original(sha, options);
  };
  await checkpoints.initialize();
  const started = Date.now();
  await checkpoints.flush();
  expect(Date.now() - started).toBeLessThan(200);
  release();
  await checkpoints.flushRemote();
  store.close();
});

test("push failure degrades remote health only and does not hot-loop", async () => {
  const { store, workspace, checkpoints, bare } = await remoteFixture();
  const other = tempDir("phi-other-");
  await runGit(other, ["init", "-b", "main"]);
  writeFileSync(join(other, "x.md"), "x\n");
  await runGit(other, ["add", "x.md"]);
  await runGit(other, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "n",
  ]);
  await runGit(other, ["remote", "add", "origin", `file://${bare}`]);
  await runGit(other, ["push", "origin", "HEAD:refs/heads/main"]);

  const git = gitOf(checkpoints);
  let pushes = 0;
  const original = git.pushSha.bind(git);
  git.pushSha = async (sha, options) => {
    pushes += 1;
    return original(sha, options);
  };
  await checkpoints.initialize();
  await checkpoints.flushRemote();
  expect(checkpoints.health().status).toBe("ok");
  expect(checkpoints.remoteHealth().status).toBe("degraded");
  expect(checkpoints.remoteHealth().error).toBe("push failed");
  expect(store.listCheckpoints(workspace.id).length).toBeGreaterThan(0);
  const afterFail = pushes;
  expect(afterFail).toBeGreaterThanOrEqual(1);
  await Bun.sleep(250);
  expect(pushes).toBe(afterFail);
  store.close();
});

test("commit-success insert-failure recovery also schedules the recovered HEAD", async () => {
  const { store, workspace, checkpoints, bare } = await remoteFixture();
  await checkpoints.initialize();
  await checkpoints.flushRemote();
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

  const git = new GitWorkspace(workspace.rootPath);
  const head = await git.head();
  expect(store.checkpointBySha(head!)).toBeNull();

  expect(await checkpoints.checkpoint({ trigger: "turn" })).toBeNull();
  expect(checkpoints.health().status).toBe("ok");
  expect(store.checkpointBySha(head!)).toBeTruthy();
  await checkpoints.flushRemote();
  const remoteHead = (await runGit(bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
  expect(remoteHead).toBe(head!);
  store.close();
});

test("flushRemote uses one overall deadline", async () => {
  const { store, checkpoints } = await remoteFixture();
  const git = gitOf(checkpoints);
  const hang = (signal?: AbortSignal) =>
    new Promise<void>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("hang")), 10_000);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  git.ensureOrigin = async (_url, options) => hang(options?.signal);
  git.pushSha = async (_sha, options) => hang(options?.signal);
  await checkpoints.initialize();
  const started = Date.now();
  await checkpoints.flushRemote(400);
  expect(Date.now() - started).toBeLessThan(400 + 200 + 500 + 750);
  expect(checkpoints.remoteHealth().status).toBe("degraded");
  store.close();
});

test("two coalesced checkpoints push the latest SHA", async () => {
  const { store, workspace, checkpoints, bare } = await remoteFixture();
  await checkpoints.initialize();
  await checkpoints.flushRemote();
  writeFileSync(join(workspace.rootPath, "channels", "a.md"), "one\n");
  await checkpoints.checkpoint({ trigger: "turn" });
  writeFileSync(join(workspace.rootPath, "channels", "a.md"), "two\n");
  const second = await checkpoints.checkpoint({ trigger: "turn" });
  await checkpoints.flushRemote();
  const remoteHead = (await runGit(bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
  expect(remoteHead).toBe(second!.commitSha);
  store.close();
});

test("close drains a newer SHA after an older in-flight push fails", async () => {
  const { store, workspace, checkpoints, bare } = await remoteFixture();
  await checkpoints.initialize();
  await checkpoints.flushRemote();
  const git = gitOf(checkpoints);
  const original = git.pushSha.bind(git);
  let calls = 0;
  let failA!: (error: Error) => void;
  const blockedA = new Promise<void>((_, reject) => {
    failA = reject;
  });
  git.pushSha = async (sha, options) => {
    calls += 1;
    if (calls === 1) await blockedA;
    return original(sha, options);
  };
  writeFileSync(join(workspace.rootPath, "channels", "a.md"), "A\n");
  await checkpoints.checkpoint({ trigger: "turn" });
  const started = Date.now();
  while (calls < 1 && Date.now() - started < 2_000) await Bun.sleep(10);
  expect(calls).toBe(1);
  writeFileSync(join(workspace.rootPath, "channels", "a.md"), "B\n");
  const shaB = await checkpoints.checkpoint({ trigger: "turn" });
  const closing = checkpoints.close();
  failA(new Error("A failed"));
  await closing;
  expect(calls).toBeGreaterThanOrEqual(2);
  const remoteHead = (await runGit(bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
  expect(remoteHead).toBe(shaB!.commitSha);
});

test("worker does not push when ensureOrigin cannot clear a stale pushurl", async () => {
  const { store, workspace, checkpoints, bare } = await remoteFixture();
  await checkpoints.initialize();
  await checkpoints.flushRemote();
  const pushedSha = store.latestCheckpoint(workspace.id)!.commitSha;
  const git = gitOf(checkpoints);
  const destB = tempDir("phi-stale-b-");
  await runGit(destB, ["init", "--bare", "-b", "main"]);
  await runGit(workspace.rootPath, [
    "remote",
    "set-url",
    "--push",
    "origin",
    `file://${destB}`,
  ]);
  (
    git as unknown as { clearOriginPushUrls: () => Promise<void> }
  ).clearOriginPushUrls = async () => undefined;
  let pushes = 0;
  const original = git.pushSha.bind(git);
  git.pushSha = async (sha, options) => {
    pushes += 1;
    return original(sha, options);
  };
  writeFileSync(join(workspace.rootPath, "channels", "stale.md"), "nope\n");
  await checkpoints.checkpoint({ trigger: "turn" });
  await checkpoints.flushRemote();
  expect(pushes).toBe(0);
  expect(checkpoints.health().status).toBe("ok");
  expect(checkpoints.remoteHealth().status).toBe("degraded");
  const bHasMain = await runGit(
    destB,
    ["rev-parse", "--verify", "-q", "refs/heads/main"],
    { allowFail: true },
  );
  expect(bHasMain.exitCode).not.toBe(0);
  const stillA = (await runGit(bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
  expect(stillA).toBe(pushedSha);
  expect(store.latestCheckpoint(workspace.id)!.commitSha).not.toBe(pushedSha);
  store.close();
});
