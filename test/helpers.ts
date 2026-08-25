import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhiDatabase } from "../src/db/database.ts";
import { PhiStore } from "../src/db/store.ts";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

export interface TestFixture {
  root: string;
  workspace: string;
  runtime: string;
  database: PhiDatabase;
  store: PhiStore;
}

export function testFixture(): TestFixture {
  const root = mkdtempSync(join(tmpdir(), "phi-test-"));
  const workspace = join(root, "workspace");
  const runtime = join(root, "runtime");
  mkdirSync(workspace);
  mkdirSync(runtime);
  git(workspace, "init", "-q");
  writeFileSync(join(workspace, "README.md"), "fixture\n");
  git(workspace, "add", "README.md");
  git(
    workspace,
    "-c",
    "user.name=Phi Test",
    "-c",
    "user.email=phi-test@localhost",
    "commit",
    "-qm",
    "initial",
  );
  const database = new PhiDatabase(join(runtime, "runtime.db"));
  database.migrate();
  const store = new PhiStore(database);
  return { root, workspace, runtime, database, store };
}

export function sourceEvent(fixture: TestFixture, content = "test") {
  return fixture.store.acceptUserMessage(content);
}

export function acceptJob(
  fixture: TestFixture,
  input: {
    adapter?: string;
    key?: string;
    prompt?: string;
    mode?: "read_only" | "mutating";
    model?: string;
    effort?: "low" | "medium" | "high";
  } = {},
) {
  sourceEvent(fixture);
  return fixture.store.acceptJob({
    adapter: input.adapter ?? "fake",
    key: input.key ?? crypto.randomUUID(),
    prompt: input.prompt ?? "fixture job",
    mode: input.mode ?? "mutating",
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  }).job;
}

export function gitRevision(workspace: string): string {
  return git(workspace, "rev-parse", "HEAD");
}
