import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { CheckpointService } from "@/core/checkpoints";
import { GitWorkspace } from "@/core/git";
import { gitRemotePath } from "@/core/paths";
import { PhiStore } from "@/core/store/store";
import { ensureWorkspace } from "@/core/workspace";
import { healthPayload } from "@/server/health";
import { tempDir } from "@/testing/tmpdir";

function gitOf(checkpoints: CheckpointService): GitWorkspace {
  return (checkpoints as unknown as { git: GitWorkspace }).git;
}

test("serialized /health omits the configured URL and classifies errors", async () => {
  const secretUrl = "https://github.com/secret-org/phi-workspace.git";
  const root = tempDir("phi-health-");
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  mkdirSync(workspace.rootPath, { recursive: true });
  ensureWorkspace(workspace.rootPath);
  writeFileSync(gitRemotePath(root), `${secretUrl}\n`);
  const checkpoints = new CheckpointService(store, workspace.rootPath);
  const git = gitOf(checkpoints);
  git.pushSha = async () => {
    throw new Error(
      `fatal: helper token=s3cret-token could not read ${secretUrl}`,
    );
  };
  await checkpoints.initialize();
  await checkpoints.flushRemote();
  const payload = healthPayload(workspace.id, checkpoints);
  const rendered = await Response.json(payload).text();
  expect(rendered).not.toContain("secret-org");
  expect(rendered).not.toContain("s3cret-token");
  expect(rendered).not.toContain(secretUrl);
  expect(payload.remote.configured).toBe(true);
  expect(payload.remote.displayUrl).toBeNull();
  expect(payload.remote.error).toBe("push failed");
  expect(payload.remote.status).toBe("degraded");
  store.close();
});
