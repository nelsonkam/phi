import { expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GitWorkspace, GIT_DRAIN_MS, GIT_TERM_GRACE_MS, phiGitEnv, runGit } from "@/core/git";
import { tempDir } from "@/testing/tmpdir";

async function phiRepo(): Promise<{ root: string; git: GitWorkspace }> {
  const root = tempDir("phi-git-");
  const git = new GitWorkspace(root);
  await git.init();
  mkdirSync(join(root, "channels"), { recursive: true });
  writeFileSync(join(root, "channels", "notes.md"), "hello\n");
  const sha = await git.capture({ checkpointId: "cp_base", trigger: "baseline" });
  expect(sha).toBeTruthy();
  return { root, git };
}

test("init creates main and seeds gitignore", async () => {
  const root = tempDir("phi-git-");
  const git = new GitWorkspace(root);
  await git.init();
  const inspect = await git.inspect();
  expect(inspect.kind).toBe("unborn");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".DS_Store");
});

test("capture is a no-op when clean", async () => {
  const { git } = await phiRepo();
  expect(await git.capture({ checkpointId: "cp_clean", trigger: "turn" })).toBeNull();
});

test("one commit contains scratch and agents edits", async () => {
  const { root, git } = await phiRepo();
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "x.md"), "agent\n");
  writeFileSync(join(root, "channels", "notes.md"), "changed\n");
  const sha = await git.capture({ checkpointId: "cp_both", trigger: "turn" });
  expect(sha).toBeTruthy();
  expect(await git.show(sha!, "channels/notes.md")).toBe("changed\n");
  expect(await git.show(sha!, ".agents/x.md")).toBe("agent\n");
});

test("ignored .DS_Store is not committed", async () => {
  const { root, git } = await phiRepo();
  writeFileSync(join(root, ".DS_Store"), "junk");
  writeFileSync(join(root, "channels", "notes.md"), "v2\n");
  const sha = await git.capture({ checkpointId: "cp_ds", trigger: "turn" });
  expect(sha).toBeTruthy();
  expect(await git.show(sha!, ".DS_Store")).toBeNull();
});

test("directory symlink is stored as a symlink", async () => {
  const { root, git } = await phiRepo();
  const outside = tempDir("phi-ext-");
  writeFileSync(join(outside, "secret.md"), "nope\n");
  symlinkSync(outside, join(root, "channels", "link"));
  const sha = await git.capture({ checkpointId: "cp_link", trigger: "turn" });
  expect(sha).toBeTruthy();
  const mode = (
    await runGit(root, ["ls-tree", sha!, "channels/link"])
  ).stdout;
  expect(mode).toContain("120000");
  expect(await git.show(sha!, "channels/link/secret.md")).toBeNull();
});

test("deleted tracked file is recorded", async () => {
  const { root, git } = await phiRepo();
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(root, "channels", "notes.md"));
  const sha = await git.capture({ checkpointId: "cp_del", trigger: "turn" });
  expect(sha).toBeTruthy();
  expect(await git.show(sha!, "channels/notes.md")).toBeNull();
});

test("staged leftovers are not in the capture commit", async () => {
  const { root, git } = await phiRepo();
  writeFileSync(join(root, "staged-only.md"), "staged\n");
  await runGit(root, ["add", "staged-only.md"]);
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(root, "staged-only.md"));
  writeFileSync(join(root, "channels", "notes.md"), "worktree\n");
  const sha = await git.capture({ checkpointId: "cp_stage", trigger: "turn" });
  expect(sha).toBeTruthy();
  expect(await git.show(sha!, "channels/notes.md")).toBe("worktree\n");
  expect(await git.show(sha!, "staged-only.md")).toBeNull();
  expect(await git.indexMatchesHead()).toBe(true);
});

test("foreign repo inspects as foreign", async () => {
  const root = tempDir("phi-git-");
  await runGit(root, ["init", "-b", "main"]);
  writeFileSync(join(root, "a.txt"), "a\n");
  await runGit(root, ["add", "a.txt"]);
  await runGit(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "n"]);
  const git = new GitWorkspace(root);
  const inspect = await git.inspect();
  expect(inspect.kind).toBe("foreign");
});

test("ancestor git toplevel is refused", async () => {
  const parent = tempDir("phi-git-");
  await runGit(parent, ["init", "-b", "main"]);
  const nested = join(parent, "workspace");
  mkdirSync(nested);
  const inspect = await new GitWorkspace(nested).inspect();
  expect(inspect.kind).toBe("ancestor");
});

test("scratch restore leaves agents files and can no-op", async () => {
  const { root, git } = await phiRepo();
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "bot.md"), "v1\n");
  writeFileSync(join(root, "channels", "notes.md"), "v1\n");
  const first = await git.capture({ checkpointId: "cp_1", trigger: "turn" });
  writeFileSync(join(root, ".agents", "bot.md"), "v2\n");
  writeFileSync(join(root, "channels", "notes.md"), "v2\n");
  await git.capture({ checkpointId: "cp_2", trigger: "turn" });
  const restored = await git.restoreScope({
    sourceSha: first!,
    scope: "scratch",
    checkpointId: "cp_rst",
  });
  expect(restored).toBeTruthy();
  expect(readFileSync(join(root, "channels", "notes.md"), "utf8")).toBe("v1\n");
  expect(readFileSync(join(root, ".agents", "bot.md"), "utf8")).toBe("v2\n");
  expect(
    await git.restoreScope({
      sourceSha: restored!,
      scope: "scratch",
      checkpointId: "cp_noop",
    }),
  ).toBeNull();
});

test("scratch restore keeps a source-tracked path ignored by current gitignore", async () => {
  const { root, git } = await phiRepo();
  writeFileSync(join(root, "channels", "keep.bin"), "bytes");
  const source = await git.capture({ checkpointId: "cp_bin", trigger: "turn" });
  writeFileSync(join(root, ".gitignore"), ".DS_Store\nchannels/keep.bin\n");
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "x.md"), "now\n");
  await git.capture({ checkpointId: "cp_ig", trigger: "turn" });
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(root, "channels", "keep.bin"));
  await git.capture({ checkpointId: "cp_gone", trigger: "turn" });
  await git.restoreScope({
    sourceSha: source!,
    scope: "scratch",
    checkpointId: "cp_back",
  });
  expect(readFileSync(join(root, "channels", "keep.bin"))).toEqual(
    Buffer.from("bytes"),
  );
  const head = await git.head();
  expect(await git.show(head!, "channels/keep.bin")).toBe("bytes");
});

test("logPhiTrailers recovers oldest-first", async () => {
  const { git } = await phiRepo();
  writeFileSync(join(git.root, "channels", "notes.md"), "a\n");
  await git.capture({ checkpointId: "cp_a", trigger: "turn" });
  writeFileSync(join(git.root, "channels", "notes.md"), "b\n");
  await git.capture({ checkpointId: "cp_b", trigger: "turn" });
  const rows = await git.logPhiTrailers();
  expect(rows.map((row) => row.checkpointId)).toEqual([
    "cp_base",
    "cp_a",
    "cp_b",
  ]);
});

test("rebase-merge and rebase-apply are hostile", async () => {
  const { root, git } = await phiRepo();
  mkdirSync(join(root, ".git", "rebase-merge"));
  expect((await git.inspect()).kind).toBe("hostile");
  const { rmSync } = await import("node:fs");
  rmSync(join(root, ".git", "rebase-merge"), { recursive: true, force: true });
  mkdirSync(join(root, ".git", "rebase-apply"));
  const inspect = await git.inspect();
  expect(inspect.kind).toBe("hostile");
  expect(inspect.mergeInProgress).toBe(true);
});

test("assumeOwned skips a full trailer scan after Phi ownership is proven", async () => {
  const { git } = await phiRepo();
  const owned = await git.inspect({ assumeOwned: true });
  expect(owned.kind).toBe("phi");
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("GIT_TERMINAL_PROMPT is set for every git spawn", () => {
  expect(phiGitEnv().GIT_TERMINAL_PROMPT).toBe("0");
});

test("timeout kills the git process group including descendants", async () => {
  const { chmodSync, readFileSync } = await import("node:fs");
  const dir = tempDir("phi-git-hang-");
  const parentPid = join(dir, "parent.pid");
  const childPid = join(dir, "child.pid");
  const script = join(dir, "fake-git");
  writeFileSync(
    script,
    `#!/bin/sh
echo $$ > ${JSON.stringify(parentPid)}
nohup sleep 86400 >/dev/null 2>&1 &
echo $! > ${JSON.stringify(childPid)}
wait
`,
  );
  chmodSync(script, 0o755);
  const started = Date.now();
  await expect(
    runGit(dir, [script], { bin: "/bin/sh", timeoutMs: 400 }),
  ).rejects.toThrow("timed out");
  expect(Date.now() - started).toBeLessThan(400 + GIT_TERM_GRACE_MS + GIT_DRAIN_MS + 750);
  const parent = Number(readFileSync(parentPid, "utf8"));
  const child = Number(readFileSync(childPid, "utf8"));
  expect(pidAlive(parent)).toBe(false);
  expect(pidAlive(child)).toBe(false);
});

test("ensureOrigin add, set-url, and leaves other remotes", async () => {
  const { root, git } = await phiRepo();
  const bare = tempDir("phi-bare-");
  await runGit(bare, ["init", "--bare", "-b", "main"]);
  const url = `file://${bare}`;
  await git.ensureOrigin(url);
  expect(await git.originUrl()).toBe(url);
  await git.ensureOrigin(url);
  expect(await git.originUrl()).toBe(url);
  const other = `file://${tempDir("phi-bare-other-")}`;
  await runGit(root, ["remote", "add", "other", other]);
  const next = `file://${tempDir("phi-bare-2-")}`;
  await git.ensureOrigin(next);
  expect(await git.originUrl()).toBe(next);
  const remotes = (await runGit(root, ["remote"])).stdout.split("\n").filter(Boolean);
  expect(remotes.sort()).toEqual(["origin", "other"]);
});

test("ensureOrigin clears a stale origin pushurl so push uses the fetch URL", async () => {
  const { root, git } = await phiRepo();
  const destA = tempDir("phi-bare-a-");
  const destB = tempDir("phi-bare-b-");
  await runGit(destA, ["init", "--bare", "-b", "main"]);
  await runGit(destB, ["init", "--bare", "-b", "main"]);
  const urlA = `file://${destA}`;
  const urlB = `file://${destB}`;
  await git.ensureOrigin(urlA);
  await runGit(root, ["remote", "set-url", "--push", "origin", urlB]);
  expect(await git.originPushUrl()).toBe(urlB);
  await git.ensureOrigin(urlA);
  expect(await git.originUrl()).toBe(urlA);
  expect(await git.originPushUrl()).toBe(urlA);
  const head = await git.head();
  await git.pushSha(head!);
  const headA = (await runGit(destA, ["rev-parse", "refs/heads/main"])).stdout.trim();
  expect(headA).toBe(head!);
  const bHasMain = await runGit(destB, ["rev-parse", "--verify", "-q", "refs/heads/main"], {
    allowFail: true,
  });
  expect(bHasMain.exitCode).not.toBe(0);
});

test("ensureOrigin rejects when a stale pushurl cannot be cleared", async () => {
  const { root, git } = await phiRepo();
  const destA = tempDir("phi-bare-a-");
  const destB = tempDir("phi-bare-b-");
  await runGit(destA, ["init", "--bare", "-b", "main"]);
  await runGit(destB, ["init", "--bare", "-b", "main"]);
  const urlA = `file://${destA}`;
  const urlB = `file://${destB}`;
  await git.ensureOrigin(urlA);
  await runGit(root, ["remote", "set-url", "--push", "origin", urlB]);
  const sticky = git as unknown as {
    clearOriginPushUrls: () => Promise<void>;
  };
  sticky.clearOriginPushUrls = async () => undefined;
  await expect(git.ensureOrigin(urlA)).rejects.toThrow(
    "origin push URL does not match the configured remote",
  );
  expect(await git.originPushUrls()).toEqual([urlB]);
});

test("successful timed runGit removes abort listeners", async () => {
  const { root } = await phiRepo();
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const drop = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "abort") added += 1;
    return add(type, listener, options);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === "abort") removed += 1;
    return drop(type, listener, options);
  }) as typeof signal.removeEventListener;
  for (let i = 0; i < 8; i++) {
    await runGit(root, ["status", "--porcelain"], {
      signal,
      timeoutMs: 5_000,
    });
  }
  expect(added).toBe(8);
  expect(removed).toBe(added);
});

test("pushSha fast-forwards a bare remote and refuses unrelated history", async () => {
  const { root, git } = await phiRepo();
  const bare = tempDir("phi-bare-push-");
  await runGit(bare, ["init", "--bare", "-b", "main"]);
  const url = `file://${bare}`;
  await git.ensureOrigin(url);
  const head = await git.head();
  expect(head).toBeTruthy();
  await git.pushSha(head!);
  const remoteHead = (
    await runGit(bare, ["rev-parse", "refs/heads/main"])
  ).stdout.trim();
  expect(remoteHead).toBe(head!);

  const other = tempDir("phi-other-writer-");
  const otherGit = new GitWorkspace(other);
  await otherGit.init();
  writeFileSync(join(other, "x.md"), "other\n");
  const otherSha = await otherGit.capture({
    checkpointId: "cp_other",
    trigger: "baseline",
  });
  await otherGit.ensureOrigin(url);
  await expect(otherGit.pushSha(otherSha!)).rejects.toThrow();
  expect(await git.head()).toBe(head!);
  expect(await otherGit.head()).toBe(otherSha!);
  const still = (await runGit(bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
  expect(still).toBe(head!);
});

