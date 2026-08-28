import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsetForScope, type RestoreScope } from "@/core/restore-scope";

export const PHI_GIT_NAME = "Phi";
export const PHI_GIT_EMAIL = "phi@local";
export const GITIGNORE_SEED = ".DS_Store\n";

export type CheckpointTrigger =
  | "baseline"
  | "turn"
  | "startup"
  | "manual"
  | "shutdown";

export interface PhiTrailer {
  sha: string;
  checkpointId: string;
  trigger: CheckpointTrigger;
  triggerThreadId: string | null;
}

export type RepoKind =
  | "missing"
  | "ancestor"
  | "unborn"
  | "foreign"
  | "phi"
  | "hostile";

export interface RepoInspection {
  kind: RepoKind;
  reason: string | null;
  toplevel: string | null;
  head: string | null;
  branch: string | null;
  indexMatchesHead: boolean;
  mergeInProgress: boolean;
  detached: boolean;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr = "",
  ) {
    super(message);
  }
}

export const GIT_TERM_GRACE_MS = 200;
export const GIT_DRAIN_MS = 500;

export interface RunGitOptions {
  indexFile?: string;
  stdin?: string;
  allowFail?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  bin?: string;
}

function gitBin(): string {
  return process.env.PHI_GIT ?? "git";
}

export function phiGitEnv(indexFile?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.GIT_AUTHOR_NAME = PHI_GIT_NAME;
  env.GIT_AUTHOR_EMAIL = PHI_GIT_EMAIL;
  env.GIT_COMMITTER_NAME = PHI_GIT_NAME;
  env.GIT_COMMITTER_EMAIL = PHI_GIT_EMAIL;
  env.GIT_LITERAL_PATHSPECS = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  return env;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortPromise(signal: AbortSignal): {
  promise: Promise<"abort">;
  dispose: () => void;
} {
  if (signal.aborted) {
    return { promise: Promise.resolve("abort"), dispose: () => undefined };
  }
  let onAbort: (() => void) | undefined;
  const promise = new Promise<"abort">((resolve) => {
    onAbort = () => resolve("abort");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

export async function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timed = options.timeoutMs !== undefined || options.signal !== undefined;
  if (options.signal?.aborted) {
    throw new GitError("git timed out");
  }
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([options.bin ?? gitBin(), ...args], {
      cwd,
      env: phiGitEnv(options.indexFile),
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: timed,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new GitError("git executable is missing");
    }
    throw error;
  }
  if (options.stdin !== undefined && proc.stdin) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }

  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const racers: Promise<{ kind: "done"; r: [string, string, number] } | "timeout" | "abort">[] = [
    finished.then((r) => ({ kind: "done" as const, r })),
  ];
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs !== undefined) {
    racers.push(
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), options.timeoutMs);
      }),
    );
  }
  let disposeAbort = () => undefined as void;
  if (options.signal) {
    const abort = abortPromise(options.signal);
    disposeAbort = abort.dispose;
    racers.push(abort.promise);
  }

  try {
    const winner = await Promise.race(racers);
    if (winner !== undefined && typeof winner !== "object") {
      const pid = proc.pid;
      if (pid !== undefined) {
        killProcessGroup(pid, "SIGTERM");
        await sleep(GIT_TERM_GRACE_MS);
        killProcessGroup(pid, "SIGKILL");
      }
      await Promise.race([finished, sleep(GIT_DRAIN_MS)]);
      throw new GitError("git timed out");
    }

    const [stdout, stderr, exitCode] = winner.r;
    if (exitCode !== 0 && !options.allowFail) {
      throw new GitError(
        `git ${args[0]} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`,
        stderr,
      );
    }
    return { stdout, stderr, exitCode };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    disposeAbort();
  }
}

class TempIndex implements Disposable {
  readonly dir: string;
  readonly path: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "phi-git-idx-"));
    this.path = join(this.dir, "index");
  }

  [Symbol.dispose](): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export class GitWorkspace {
  constructor(readonly root: string) {}

  async inspect(options: { assumeOwned?: boolean } = {}): Promise<RepoInspection> {
    const toplevelResult = await runGit(
      this.root,
      ["rev-parse", "--show-toplevel"],
      { allowFail: true },
    );
    const toplevel = toplevelResult.stdout.trim() || null;
    if (toplevel && canonicalize(toplevel) !== canonicalize(this.root)) {
      return {
        ...emptyInspection("ancestor", "git toplevel is not the workspace root"),
        toplevel,
      };
    }
    const gitDir = join(this.root, ".git");
    if (!existsSync(gitDir)) {
      return emptyInspection("missing", null);
    }
    if (existsSync(join(this.root, ".git", "index.lock"))) {
      return {
        ...emptyInspection("hostile", "index lock is held"),
        toplevel,
      };
    }
    if (mergeInProgress(this.root)) {
      return {
        ...emptyInspection("hostile", "merge or rebase in progress"),
        toplevel,
        mergeInProgress: true,
      };
    }
    const headResult = await runGit(
      this.root,
      ["rev-parse", "--verify", "-q", "HEAD"],
      { allowFail: true },
    );
    const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const symbolic = await runGit(this.root, ["symbolic-ref", "-q", "HEAD"], {
      allowFail: true,
    });
    const detached = Boolean(head) && symbolic.exitCode !== 0;
    const branchResult = await runGit(
      this.root,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { allowFail: true },
    );
    const branch =
      branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
    if (head && detached) {
      return {
        kind: "hostile",
        reason: "detached HEAD",
        toplevel,
        head,
        branch: null,
        indexMatchesHead: false,
        mergeInProgress: false,
        detached: true,
      };
    }
    if (head && branch && branch !== "main" && branch !== "master") {
      return {
        kind: "hostile",
        reason: `unexpected branch ${branch}`,
        toplevel,
        head,
        branch,
        indexMatchesHead: false,
        mergeInProgress: false,
        detached: false,
      };
    }
    if (!head) {
      return {
        kind: "unborn",
        reason: null,
        toplevel,
        head: null,
        branch: branch || "main",
        indexMatchesHead: await indexEmpty(this.root),
        mergeInProgress: false,
        detached: false,
      };
    }
    const indexMatchesHead = await this.indexMatchesHead();
    const owned = options.assumeOwned || (await this.hasPhiTrailer());
    return {
      kind: owned ? "phi" : "foreign",
      reason: owned ? null : "no Phi-Checkpoint trailer in reachable history",
      toplevel,
      head,
      branch,
      indexMatchesHead,
      mergeInProgress: false,
      detached: false,
    };
  }

  async init(): Promise<void> {
    await runGit(this.root, ["init", "-b", "main"]);
    const ignore = join(this.root, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE_SEED);
  }

  async head(): Promise<string | null> {
    const result = await runGit(this.root, ["rev-parse", "--verify", "-q", "HEAD"], {
      allowFail: true,
    });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async indexMatchesHead(): Promise<boolean> {
    const head = await this.head();
    if (!head) return await indexEmpty(this.root);
    const diff = await runGit(
      this.root,
      ["diff-index", "--cached", "--quiet", "HEAD"],
      { allowFail: true },
    );
    return diff.exitCode === 0;
  }

  async normalizeIndexToHead(): Promise<void> {
    const head = await this.head();
    if (!head) {
      await runGit(this.root, ["read-tree", "--empty"]);
      return;
    }
    await runGit(this.root, ["read-tree", "HEAD"]);
  }

  async isDirty(): Promise<boolean> {
    using index = new TempIndex();
    const head = await this.head();
    if (head) await runGit(this.root, ["read-tree", "HEAD"], { indexFile: index.path });
    else await runGit(this.root, ["read-tree", "--empty"], { indexFile: index.path });
    await runGit(this.root, ["add", "-A", "--", "."], { indexFile: index.path });
    if (!head) {
      const tree = (
        await runGit(this.root, ["write-tree"], { indexFile: index.path })
      ).stdout.trim();
      const empty = (
        await runGit(this.root, ["mktree"], { stdin: "" })
      ).stdout.trim();
      return tree !== empty;
    }
    const cached = await runGit(
      this.root,
      ["diff", "--cached", "--quiet"],
      { indexFile: index.path, allowFail: true },
    );
    return cached.exitCode !== 0;
  }

  async lsTree(rev: string): Promise<string[]> {
    const result = await runGit(this.root, ["ls-tree", "-r", "-z", "--name-only", rev]);
    return result.stdout.split("\0").filter(Boolean);
  }

  async logPhiTrailers(sinceExclusive?: string | null): Promise<PhiTrailer[]> {
    const args = ["log", "--format=%H%n%B%n==END=="];
    if (sinceExclusive) args.push(`${sinceExclusive}..HEAD`);
    else args.push("HEAD");
    const result = await runGit(this.root, args, { allowFail: true });
    if (result.exitCode !== 0) return [];
    const trailers: PhiTrailer[] = [];
    for (const block of result.stdout.split("==END==\n")) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const nl = trimmed.indexOf("\n");
      const sha = nl === -1 ? trimmed : trimmed.slice(0, nl);
      const body = nl === -1 ? "" : trimmed.slice(nl + 1);
      const parsed = parseTrailers(body);
      if (!parsed) continue;
      trailers.push({ sha, ...parsed });
    }
    return trailers.reverse();
  }

  async isAncestor(maybeAncestor: string, head?: string): Promise<boolean> {
    const tip = head ?? (await this.head());
    if (!tip) return false;
    const result = await runGit(
      this.root,
      ["merge-base", "--is-ancestor", maybeAncestor, tip],
      { allowFail: true },
    );
    return result.exitCode === 0;
  }

  private provenOwned = false;

  async hasPhiTrailer(): Promise<boolean> {
    if (this.provenOwned) return true;
    const headBody = (
      await runGit(this.root, ["log", "-1", "--format=%B"], { allowFail: true })
    ).stdout;
    if (parseTrailers(headBody)) {
      this.provenOwned = true;
      return true;
    }
    const trailers = await this.logPhiTrailers();
    if (trailers.length > 0) {
      this.provenOwned = true;
      return true;
    }
    return false;
  }

  async capture(input: {
    checkpointId: string;
    trigger: CheckpointTrigger;
    triggerThreadId?: string | null;
  }): Promise<string | null> {
    using index = new TempIndex();
    const head = await this.head();
    if (head) await runGit(this.root, ["read-tree", "HEAD"], { indexFile: index.path });
    else await runGit(this.root, ["read-tree", "--empty"], { indexFile: index.path });
    await runGit(this.root, ["add", "-A", "--", "."], { indexFile: index.path });
    if (head) {
      const cached = await runGit(
        this.root,
        ["diff", "--cached", "--quiet"],
        { indexFile: index.path, allowFail: true },
      );
      if (cached.exitCode === 0) return null;
    } else {
      const tree = (
        await runGit(this.root, ["write-tree"], { indexFile: index.path })
      ).stdout.trim();
      const empty = (await runGit(this.root, ["mktree"], { stdin: "" })).stdout.trim();
      if (tree === empty) return null;
    }
    await this.commitIndex(index.path, input);
    const sha = await this.head();
    if (!sha) throw new GitError("commit did not create HEAD");
    await this.normalizeIndexToHead();
    return sha;
  }

  async restoreScope(input: {
    sourceSha: string;
    scope: RestoreScope;
    checkpointId: string;
  }): Promise<string | null> {
    const head = await this.head();
    if (!head) throw new GitError("cannot restore without HEAD");
    using index = new TempIndex();
    await runGit(this.root, ["read-tree", "HEAD"], { indexFile: index.path });
    if (input.scope === "all") {
      await runGit(
        this.root,
        ["restore", "--source", input.sourceSha, "--worktree", "--staged", "--", "."],
        { indexFile: index.path },
      );
    } else {
      const paths = pathsetForScope(
        input.scope,
        await this.lsTree("HEAD"),
        await this.lsTree(input.sourceSha),
      );
      if (paths.length > 0) {
        await runGit(
          this.root,
          [
            "restore",
            "--source",
            input.sourceSha,
            "--worktree",
            "--staged",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          { indexFile: index.path, stdin: `${paths.join("\0")}\0` },
        );
      }
    }
    const tree = (
      await runGit(this.root, ["write-tree"], { indexFile: index.path })
    ).stdout.trim();
    const headTree = (
      await runGit(this.root, ["rev-parse", "HEAD^{tree}"])
    ).stdout.trim();
    if (tree === headTree) return null;
    await this.commitIndex(index.path, {
      checkpointId: input.checkpointId,
      trigger: "manual",
    });
    const sha = await this.head();
    if (!sha) throw new GitError("restore commit did not create HEAD");
    await this.normalizeIndexToHead();
    return sha;
  }

  async show(rev: string, path: string): Promise<string | null> {
    const result = await runGit(this.root, ["show", `${rev}:${path}`], {
      allowFail: true,
    });
    return result.exitCode === 0 ? result.stdout : null;
  }

  async originUrl(): Promise<string | null> {
    const result = await runGit(this.root, ["remote", "get-url", "origin"], {
      allowFail: true,
    });
    const url = result.stdout.trim();
    return result.exitCode === 0 && url ? url : null;
  }

  async originPushUrls(
    options: Pick<RunGitOptions, "timeoutMs" | "signal"> = {},
  ): Promise<string[]> {
    const result = await runGit(
      this.root,
      ["remote", "get-url", "--all", "--push", "origin"],
      { ...options, allowFail: true },
    );
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async originPushUrl(): Promise<string | null> {
    const urls = await this.originPushUrls();
    return urls[0] ?? null;
  }

  async ensureOrigin(
    url: string,
    options: Pick<RunGitOptions, "timeoutMs" | "signal"> = {},
  ): Promise<void> {
    const current = await this.originUrl();
    if (current === null) {
      await runGit(this.root, ["remote", "add", "origin", url], options);
    } else if (current !== url) {
      await runGit(this.root, ["remote", "set-url", "origin", url], options);
    }
    await this.clearOriginPushUrls(options);
    const pushUrls = await this.originPushUrls(options);
    if (pushUrls.length !== 1 || pushUrls[0] !== url) {
      throw new GitError("origin push URL does not match the configured remote");
    }
  }

  protected async clearOriginPushUrls(
    options: Pick<RunGitOptions, "timeoutMs" | "signal"> = {},
  ): Promise<void> {
    await runGit(
      this.root,
      ["config", "--unset-all", "remote.origin.pushurl"],
      { ...options, allowFail: true },
    );
  }

  async pushSha(
    sha: string,
    options: Pick<RunGitOptions, "timeoutMs" | "signal"> = {},
  ): Promise<void> {
    await runGit(
      this.root,
      ["push", "--porcelain", "origin", `${sha}:refs/heads/main`],
      options,
    );
  }

  private async commitIndex(
    indexFile: string,
    input: {
      checkpointId: string;
      trigger: CheckpointTrigger;
      triggerThreadId?: string | null;
    },
  ): Promise<void> {
    const lines = [
      "phi checkpoint",
      "",
      `Phi-Checkpoint: ${input.checkpointId}`,
      `Trigger: ${input.trigger}`,
    ];
    if (input.triggerThreadId) {
      lines.push(`Trigger-Thread: ${input.triggerThreadId}`);
    }
    await runGit(
      this.root,
      ["commit", "--no-verify", "-F", "-"],
      { indexFile, stdin: `${lines.join("\n")}\n` },
    );
  }
}

function parseTrailers(
  body: string,
): Omit<PhiTrailer, "sha"> | null {
  const checkpointId = trailerValue(body, "Phi-Checkpoint");
  const trigger = trailerValue(body, "Trigger") as CheckpointTrigger | null;
  if (!checkpointId || !isTrigger(trigger)) return null;
  const thread = trailerValue(body, "Trigger-Thread");
  return {
    checkpointId,
    trigger,
    triggerThreadId: thread || null,
  };
}

function isTrigger(value: string | null): value is CheckpointTrigger {
  return (
    value === "baseline" ||
    value === "turn" ||
    value === "startup" ||
    value === "manual" ||
    value === "shutdown"
  );
}

function trailerValue(body: string, key: string): string | null {
  const match = body.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function mergeInProgress(root: string): boolean {
  const dir = join(root, ".git");
  return (
    existsSync(join(dir, "MERGE_HEAD")) ||
    existsSync(join(dir, "REBASE_HEAD")) ||
    existsSync(join(dir, "rebase-merge")) ||
    existsSync(join(dir, "rebase-apply")) ||
    existsSync(join(dir, "CHERRY_PICK_HEAD")) ||
    existsSync(join(dir, "REVERT_HEAD"))
  );
}

async function indexEmpty(root: string): Promise<boolean> {
  const result = await runGit(root, ["diff-index", "--cached", "--quiet", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"], {
    allowFail: true,
  });
  // empty tree SHA; if no index, treat as empty
  if (!existsSync(join(root, ".git", "index"))) return true;
  const cached = await runGit(root, ["ls-files"], { allowFail: true });
  return cached.stdout.trim() === "";
}

function emptyInspection(kind: RepoKind, reason: string | null): RepoInspection {
  return {
    kind,
    reason,
    toplevel: null,
    head: null,
    branch: null,
    indexMatchesHead: true,
    mergeInProgress: false,
    detached: false,
  };
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path).replace(/\/+$/, "");
  } catch {
    return path.replace(/\/+$/, "");
  }
}
