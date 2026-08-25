import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CompletionService } from "../src/jobs/completion.ts";
import { RecoveryService } from "../src/jobs/recovery.ts";
import { JobScheduler } from "../src/jobs/scheduler.ts";
import { WorkerAdapterRegistry } from "../src/workers/adapter.ts";
import { FakeWorkerAdapter } from "../src/workers/fake.ts";
import { GitService } from "../src/workspace/git.ts";
import { acceptJob, testFixture, type TestFixture } from "./helpers.ts";

let fixture: TestFixture | null = null;
afterEach(() => {
  fixture?.database.close();
  fixture = null;
});

test("recovery completes the checkpoint-before-visibility crash boundary", async () => {
  fixture = testFixture();
  expect(fixture.store.claimNextJob()).toBeNull();
  const accepted = acceptJob(fixture, { key: "crash-boundary" });
  const running = fixture.store.recordRunning(
    fixture.store.claimNextJob()!.id,
    "fake-crash-boundary",
  );
  const begun = fixture.store.beginCompletion({
    jobId: accepted.id,
    kind: "worker_completed",
    dedupeKey: "worker:fake:crash-boundary:terminal",
    payload: { summary: "finished before crash" },
  });
  writeFileSync(join(fixture.workspace, "worker-output.txt"), "recovered\n");
  expect(fixture.store.getJob(running.id).status).toBe("completing");
  expect(fixture.store.getEvent(begun.event.id).visibleAt).toBeNull();

  const git = new GitService(fixture.workspace);
  const adapters = new WorkerAdapterRegistry();
  adapters.register(new FakeWorkerAdapter());
  const completion = new CompletionService(fixture.store, git, () => undefined);
  const scheduler = new JobScheduler({
    store: fixture.store,
    adapters,
    completion,
    workspace: fixture.workspace,
    concurrency: 2,
  });
  await new RecoveryService({
    store: fixture.store,
    adapters,
    completion,
    scheduler,
    git,
  }).recover();

  const recovered = fixture.store.getJob(accepted.id);
  expect(recovered.status).toBe("completed");
  expect(recovered.observedTerminalCommit).not.toBeNull();
  if (!recovered.observedTerminalCommit)
    throw new Error("recovery did not record a terminal commit");
  expect(fixture.store.getEvent(begun.event.id).visibleAt).not.toBeNull();
  const checkpoint = fixture.store.raw
    .query("SELECT id,commit_sha FROM git_checkpoints WHERE id=?")
    .get(begun.event.id) as { id: string; commit_sha: string } | null;
  expect(checkpoint?.id).toBe(begun.event.id);
  expect(checkpoint?.commit_sha).toBe(recovered.observedTerminalCommit);
});
