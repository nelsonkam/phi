import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CheckpointService } from "@/core/checkpoints";
import { GitWorkspace, runGit } from "@/core/git";
import { gitRemotePath } from "@/core/paths";
import { PhiStore } from "@/core/store/store";
import { ensureWorkspace } from "@/core/workspace";
import {
  getGitRemoteSettings,
  putGitRemoteSettings,
} from "@/server/git-remote-settings";
import type { GitRemoteSettings } from "@/shared/types";
import { tempDir } from "@/testing/tmpdir";

function fixture() {
  const root = tempDir("phi-remote-api-");
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  mkdirSync(workspace.rootPath, { recursive: true });
  ensureWorkspace(workspace.rootPath);
  const checkpoints = new CheckpointService(store, workspace.rootPath);
  return { root, store, checkpoints };
}

async function put(
  root: string,
  checkpoints: CheckpointService,
  url: unknown,
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number; body: GitRemoteSettings & { error?: string } }> {
  const res = await putGitRemoteSettings(
    new Request("http://localhost/api/v1/settings/git-remote", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
    root,
    checkpoints,
    env,
  );
  return { status: res.status, body: (await res.json()) as GitRemoteSettings & { error?: string } };
}

test("GET is unset until PUT writes the file remote", async () => {
  const { root, store, checkpoints } = fixture();
  const empty = await getGitRemoteSettings(root, checkpoints, {}).json() as GitRemoteSettings;
  expect(empty).toMatchObject({
    url: null,
    source: "unset",
    locked: false,
    parseError: null,
    health: { status: "unset", configured: false },
  });

  const saved = await put(
    root,
    checkpoints,
    "https://github.com/owner/phi-workspace.git",
  );
  expect(saved.status).toBe(200);
  expect(saved.body.url).toBe("https://github.com/owner/phi-workspace.git");
  expect(saved.body.source).toBe("file");
  expect(saved.body.locked).toBe(false);
  expect(readFileSync(gitRemotePath(root), "utf8")).toBe(
    "https://github.com/owner/phi-workspace.git\n",
  );

  const got = await getGitRemoteSettings(root, checkpoints, {}).json() as GitRemoteSettings;
  expect(got.url).toBe("https://github.com/owner/phi-workspace.git");
  store.close();
});

test("PUT rejects invalid URLs, env lock, and missing url", async () => {
  const { root, store, checkpoints } = fixture();
  const invalid = await put(
    root,
    checkpoints,
    "https://user@github.com/owner/repo.git",
  );
  expect(invalid.status).toBe(400);
  expect(invalid.body.error).toContain("userinfo");
  expect(existsSync(gitRemotePath(root))).toBe(false);

  const locked = await put(
    root,
    checkpoints,
    "https://github.com/owner/repo.git",
    { PHI_GIT_REMOTE: "https://github.com/from-env/repo.git" },
  );
  expect(locked.status).toBe(409);
  expect(existsSync(gitRemotePath(root))).toBe(false);

  const missing = await putGitRemoteSettings(
    new Request("http://localhost/api/v1/settings/git-remote", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    root,
    checkpoints,
    {},
  );
  expect(missing.status).toBe(400);
  store.close();
});

test("PUT null clears the file remote", async () => {
  const { root, store, checkpoints } = fixture();
  await put(root, checkpoints, "git@github.com:owner/repo.git");
  const cleared = await put(root, checkpoints, null);
  expect(cleared.status).toBe(200);
  expect(cleared.body).toMatchObject({
    url: null,
    source: "unset",
    health: { status: "unset", configured: false },
  });
  expect(existsSync(gitRemotePath(root))).toBe(false);
  store.close();
});

test("PUT of the same URL after a failed push returns pending then succeeds", async () => {
  const root = tempDir("phi-remote-retry-");
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  mkdirSync(workspace.rootPath, { recursive: true });
  ensureWorkspace(workspace.rootPath);
  const bare = tempDir("phi-bare-retry-");
  await runGit(bare, ["init", "--bare", "-b", "main"]);
  const url = `file://${bare}`;
  writeFileSync(gitRemotePath(root), `${url}\n`);
  const checkpoints = new CheckpointService(store, workspace.rootPath);
  const git = (checkpoints as unknown as { git: GitWorkspace }).git;
  let failNext = true;
  const original = git.pushSha.bind(git);
  git.pushSha = async (sha, options) => {
    if (failNext) {
      failNext = false;
      throw new Error("rejected non-fast-forward");
    }
    return original(sha, options);
  };
  await checkpoints.initialize();
  await checkpoints.flushRemote();
  expect(checkpoints.remoteHealth().status).toBe("degraded");

  const retried = await put(root, checkpoints, url);
  expect(retried.status).toBe(200);
  expect(retried.body.health.status).toBe("pending");
  expect(retried.body.health.error).toBeNull();

  await checkpoints.flushRemote();
  const got = (await getGitRemoteSettings(root, checkpoints, {}).json()) as GitRemoteSettings;
  expect(got.health.status).toBe("ok");
  expect(got.health.error).toBeNull();
  store.close();
});
