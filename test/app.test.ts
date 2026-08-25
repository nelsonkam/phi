import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhiApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { testFixture, type TestFixture } from "./helpers.ts";

let fixture: TestFixture | null = null;
let app: PhiApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.database.close();
  fixture = null;
});

test("application startup initializes an unversioned workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "phi-app-bootstrap-"));
  const workspace = join(root, "workspace");
  const runtime = join(root, "runtime");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "existing.txt"), "baseline\n");
  app = await PhiApp.create(loadConfig({ workspace, runtimeDir: runtime }), {
    directCoordinator: true,
  });
  expect(await app.git.isRepository()).toBeTrue();
  expect(await app.git.currentRevision()).not.toBeNull();
  expect(await app.git.status()).toBe("");
});

test("direct coordinator runs fake job end-to-end with deduped terminal delivery", async () => {
  fixture = testFixture();
  fixture.database.close();
  const config = loadConfig({
    workspace: fixture.workspace,
    runtimeDir: fixture.runtime,
    concurrency: 4,
  });
  app = await PhiApp.create(config, {
    directCoordinator: true,
  });
  app.start();
  await app.submitUserMessage(
    "/dispatch fake mutating finish [fake:duplicate]",
  );
  await app.waitUntilIdle();
  expect(app.store.listJobs()).toHaveLength(1);
  expect(app.store.listJobs()[0]!.status).toBe("completed");
  expect(app.store.listJobs()[0]!.model).toBe("fake-deterministic");
  expect(app.store.listMessages().map((message) => message.kind)).toEqual([
    "ack",
    "result",
  ]);
  expect(
    new Set(app.store.listMessages().map((message) => message.idempotencyKey))
      .size,
  ).toBe(2);
  expect(
    app.store.listEvents().filter((event) => event.kind === "worker_completed"),
  ).toHaveLength(1);
});

test("needs_input, durable follow-up, and completion are wired end-to-end", async () => {
  fixture = testFixture();
  fixture.database.close();
  app = await PhiApp.create(
    loadConfig({ workspace: fixture.workspace, runtimeDir: fixture.runtime }),
    { directCoordinator: true },
  );
  app.start();
  await app.submitUserMessage(
    "/dispatch fake read_only ask [fake:needs_input]",
  );
  await app.waitUntilIdle();
  const job = app.store.listJobs()[0]!;
  expect(job.status).toBe("needs_input");
  expect(
    app.store.listMessages().some((message) => message.kind === "question"),
  ).toBeTrue();
  await app.submitUserMessage(`/follow ${job.id} accepted`);
  await app.waitUntilIdle();
  expect(app.store.getJob(job.id).status).toBe("completed");
  expect(app.store.listMessages().at(-1)?.kind).toBe("result");
});

test("cancellation intent is persisted before the live adapter is aborted", async () => {
  fixture = testFixture();
  fixture.database.close();
  app = await PhiApp.create(
    loadConfig({ workspace: fixture.workspace, runtimeDir: fixture.runtime }),
    { directCoordinator: true },
  );
  app.start();
  await app.submitUserMessage("/dispatch fake mutating wait [fake:delay=1000]");
  const deadline = Date.now() + 2_000;
  while (app.store.listJobs()[0]?.status !== "running") {
    if (Date.now() >= deadline) throw new Error("fake job did not start");
    await Bun.sleep(5);
  }
  const job = app.store.listJobs()[0]!;
  await app.submitUserMessage(`/cancel ${job.id}`);
  await app.waitUntilIdle();
  const cancelled = app.store.getJob(job.id);
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.cancelKey).toContain(job.id);
  expect(app.store.listMessages().at(-1)?.kind).toBe("result");
});
