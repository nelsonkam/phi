import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyRemoteError,
  parseGitRemoteUrl,
  readGitRemoteConfig,
} from "@/core/git-remote";
import { gitRemotePath } from "@/core/paths";
import { tempDir } from "@/testing/tmpdir";

test("accepts https, ssh, scp, and file URLs", () => {
  expect(parseGitRemoteUrl("https://github.com/owner/repo.git")).toEqual({
    kind: "ok",
    url: "https://github.com/owner/repo.git",
    displayUrl: null,
  });
  expect(parseGitRemoteUrl("ssh://git@github.com/owner/repo.git")).toEqual({
    kind: "ok",
    url: "ssh://git@github.com/owner/repo.git",
    displayUrl: null,
  });
  expect(parseGitRemoteUrl("git@github.com:owner/repo.git")).toEqual({
    kind: "ok",
    url: "git@github.com:owner/repo.git",
    displayUrl: null,
  });
  expect(parseGitRemoteUrl("file:///tmp/backup.git").kind).toBe("ok");
  expect(parseGitRemoteUrl("file:///tmp/backup.git")).toMatchObject({
    displayUrl: null,
  });
});

test("rejects passwords, HTTPS userinfo, query, fragment, http, and git schemes", () => {
  expect(parseGitRemoteUrl("https://user@github.com/owner/repo.git").kind).toBe(
    "invalid",
  );
  expect(parseGitRemoteUrl("https://user:pass@github.com/owner/repo.git").kind).toBe(
    "invalid",
  );
  expect(parseGitRemoteUrl("https://github.com/owner/repo.git?token=secret").kind).toBe(
    "invalid",
  );
  expect(parseGitRemoteUrl("https://github.com/owner/repo.git#frag").kind).toBe(
    "invalid",
  );
  expect(parseGitRemoteUrl("ssh://git:pass@github.com/owner/repo.git").kind).toBe(
    "invalid",
  );
  expect(parseGitRemoteUrl("git:pass@github.com:owner/repo.git").kind).toBe("invalid");
  expect(parseGitRemoteUrl("http://github.com/owner/repo.git").kind).toBe("invalid");
  expect(parseGitRemoteUrl("git://github.com/owner/repo.git").kind).toBe("invalid");
  expect(parseGitRemoteUrl("origin").kind).toBe("invalid");
  expect(parseGitRemoteUrl("-u https://example.com/repo.git").kind).toBe("invalid");
});

test("env URL wins over the git-remote file", () => {
  const root = tempDir("phi-remote-cfg-");
  writeFileSync(gitRemotePath(root), "git@example.com:from-file/repo.git\n");
  const fromFile = readGitRemoteConfig(root, {});
  expect(fromFile.kind === "ok" && fromFile.url).toBe(
    "git@example.com:from-file/repo.git",
  );
  const fromEnv = readGitRemoteConfig(root, {
    PHI_GIT_REMOTE: "https://github.com/from-env/repo.git",
  });
  expect(fromEnv.kind === "ok" && fromEnv.url).toBe(
    "https://github.com/from-env/repo.git",
  );
});

test("missing file is unset; extra lines are invalid", () => {
  const root = tempDir("phi-remote-cfg-");
  expect(readGitRemoteConfig(root, {}).kind).toBe("unset");
  writeFileSync(gitRemotePath(root), "https://github.com/a/b.git\nhttps://github.com/c/d.git\n");
  expect(readGitRemoteConfig(root, {}).kind).toBe("invalid");
});

test("reads the file from the given root, not phiRoot()", () => {
  const root = tempDir("phi-remote-root-");
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(gitRemotePath(root), "git@example.com:store-root/repo.git\n");
  const parsed = readGitRemoteConfig(root, {});
  expect(parsed.kind === "ok" && parsed.url).toBe(
    "git@example.com:store-root/repo.git",
  );
});

test("classifyRemoteError maps stderr to stable classes", () => {
  expect(classifyRemoteError(new Error("git timed out"))).toBe("timed out");
  expect(
    classifyRemoteError(new Error("Permission denied (publickey)")),
  ).toBe("authentication failed");
  expect(
    classifyRemoteError(new Error("! [rejected] non-fast-forward helper-token=abc")),
  ).toBe("push failed");
});
