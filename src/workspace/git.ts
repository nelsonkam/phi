import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { newId } from "../ids.ts";

export interface CheckpointResult {
  checkpointId: string | null;
  commit: string | null;
  created: boolean;
}

export interface GitInitializationResult {
  repositoryInitialized: boolean;
  baselineCreated: boolean;
  revision: string;
}

function normalized(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function runGit(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0 && !allowFailure)
    throw new Error(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export class GitService {
  private checkpointTail: Promise<void> = Promise.resolve();

  constructor(readonly workspace: string) {}

  async repositoryRoot(): Promise<string | null> {
    const result = await runGit(
      this.workspace,
      ["rev-parse", "--show-toplevel"],
      true,
    );
    return result.code === 0 ? result.stdout : null;
  }

  async isRepository(): Promise<boolean> {
    const root = await this.repositoryRoot();
    return root !== null && normalized(root) === normalized(this.workspace);
  }

  async ensureInitialized(): Promise<GitInitializationResult> {
    let repositoryInitialized = false;
    if (!(await this.isRepository())) {
      await runGit(this.workspace, ["init", "-q"]);
      repositoryInitialized = true;
    }
    let revision = await this.currentRevision();
    let baselineCreated = false;
    if (!revision) {
      await runGit(this.workspace, ["add", "-A"]);
      await runGit(this.workspace, [
        "-c",
        "user.name=Phi",
        "-c",
        "user.email=phi@localhost",
        "commit",
        "--allow-empty",
        "-qm",
        "phi baseline: initialize workspace\n\nPhi-Baseline: true",
      ]);
      revision = await this.currentRevision();
      baselineCreated = true;
    }
    if (!revision) throw new Error("Git initialization did not create HEAD");
    return { repositoryInitialized, baselineCreated, revision };
  }

  async currentRevision(): Promise<string | null> {
    const result = await runGit(this.workspace, ["rev-parse", "HEAD"], true);
    return result.code === 0 ? result.stdout : null;
  }

  async status(): Promise<string> {
    return (
      await runGit(this.workspace, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])
    ).stdout;
  }

  async findCheckpoint(checkpointId: string): Promise<string | null> {
    const result = await runGit(
      this.workspace,
      ["log", "--all", "--format=%H%x00%B%x00", "-n", "200"],
      true,
    );
    if (result.code !== 0) return null;
    const entries = result.stdout.split("\0");
    for (let index = 0; index + 1 < entries.length; index += 2) {
      if (entries[index + 1]?.includes(`Phi-Checkpoint: ${checkpointId}`))
        return entries[index] || null;
    }
    return null;
  }

  checkpoint(input: {
    triggerJobId?: string;
    status: string;
    checkpointId?: string;
  }): Promise<CheckpointResult> {
    const operation = async (): Promise<CheckpointResult> => {
      const checkpointId = input.checkpointId ?? newId();
      const existing = await this.findCheckpoint(checkpointId);
      if (existing) return { checkpointId, commit: existing, created: false };
      const before = await this.currentRevision();
      if (!(await this.status()))
        return { checkpointId: null, commit: before, created: false };
      await runGit(this.workspace, ["add", "-A"]);
      const message = [
        `phi checkpoint: ${input.status}`,
        "",
        `Phi-Checkpoint: ${checkpointId}`,
        `Trigger-Job: ${input.triggerJobId ?? "none"}`,
      ].join("\n");
      await runGit(this.workspace, [
        "-c",
        "user.name=Phi",
        "-c",
        "user.email=phi@localhost",
        "commit",
        "-m",
        message,
      ]);
      return {
        checkpointId,
        commit: await this.currentRevision(),
        created: true,
      };
    };
    const result = this.checkpointTail.then(operation, operation);
    this.checkpointTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
