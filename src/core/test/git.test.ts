import { expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GitWorkspace, runGit } from "@/core/git";
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
