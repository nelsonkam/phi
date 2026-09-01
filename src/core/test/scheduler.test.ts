import { expect, test } from "bun:test";
import { SchedulerService, nextOccurrence } from "@/core/scheduler";
import { PhiStore } from "@/core/store/store";
import { tempDir } from "@/testing/tmpdir";

test("computes interval and timezone-aware cron occurrences", () => {
  const after = new Date("2026-08-30T00:00:00.000Z");
  expect(
    nextOccurrence({ kind: "interval", everyMs: 60_000 }, after)?.toISOString(),
  ).toBe("2026-08-30T00:01:00.000Z");
  expect(
    nextOccurrence(
      { kind: "cron", expression: "0 3 * * *", timezone: "UTC" },
      after,
    )?.toISOString(),
  ).toBe("2026-08-30T03:00:00.000Z");
  expect(() =>
    nextOccurrence({ kind: "cron", expression: "not a cron" }, after),
  ).toThrow();
});

test("persists task definitions and runs an overdue task once", async () => {
  const root = tempDir();
  const store = new PhiStore(root);
  let now = new Date("2026-08-30T00:00:00.000Z");
  const scheduler = new SchedulerService(store, () => now);
  scheduler.upsertTask({
    id: "test.heartbeat",
    handler: "heartbeat",
    schedule: { kind: "interval", everyMs: 60_000 },
    payload: { source: "test" },
  });
  expect(scheduler.getTask("test.heartbeat")?.nextRunAt).toBe(
    "2026-08-30T00:01:00.000Z",
  );
  scheduler.close();
  store.close();

  const reopened = new PhiStore(root);
  const resumed = new SchedulerService(reopened, () => now);
  const calls: unknown[] = [];
  resumed.registerHandler("heartbeat", (payload) => {
    calls.push(payload);
  });
  now = new Date("2026-08-30T00:02:00.000Z");
  // Server startup re-registers built-ins; an unchanged definition must not
  // erase the persisted overdue run before catch-up can claim it.
  resumed.upsertTask({
    id: "test.heartbeat",
    handler: "heartbeat",
    schedule: { kind: "interval", everyMs: 60_000 },
    payload: { source: "test" },
  });
  expect(resumed.getTask("test.heartbeat")?.nextRunAt).toBe(
    "2026-08-30T00:01:00.000Z",
  );
  resumed.start();
  expect(await resumed.runDue(now)).toBe(1);
  expect(calls).toEqual([{ source: "test" }]);
  expect(resumed.getTask("test.heartbeat")).toMatchObject({
    nextRunAt: "2026-08-30T00:03:00.000Z",
    lastRunAt: "2026-08-30T00:02:00.000Z",
    lastError: null,
    failureCount: 0,
  });
  expect(resumed.deleteTask("test.heartbeat")).toBe(true);
  expect(resumed.getTask("test.heartbeat")).toBeNull();
  expect(resumed.deleteTask("test.heartbeat")).toBe(false);
  resumed.close();
  reopened.close();
});

test("a built-in can request one immediate first run", () => {
  const store = new PhiStore(tempDir());
  const now = new Date("2026-08-30T12:00:00.000Z");
  const scheduler = new SchedulerService(store, () => now);
  scheduler.upsertTask({
    id: "system.reflection",
    handler: "reflection",
    schedule: { kind: "cron", expression: "0 3 * * *", timezone: "UTC" },
    initialRun: "now",
  });
  expect(scheduler.getTask("system.reflection")?.nextRunAt).toBe(
    now.toISOString(),
  );
  scheduler.close();
  store.close();
});

test("skip catch-up advances missed work without executing it", async () => {
  const store = new PhiStore(tempDir());
  let now = new Date("2026-08-30T00:00:00.000Z");
  const scheduler = new SchedulerService(store, () => now);
  let calls = 0;
  scheduler.registerHandler("cleanup", () => {
    calls += 1;
  });
  scheduler.upsertTask({
    id: "test.cleanup",
    handler: "cleanup",
    schedule: { kind: "interval", everyMs: 60_000 },
    catchUp: "skip",
  });
  now = new Date("2026-08-30T00:05:00.000Z");
  scheduler.start();
  expect(await scheduler.runDue(now)).toBe(0);
  expect(calls).toBe(0);
  expect(scheduler.getTask("test.cleanup")?.nextRunAt).toBe(
    "2026-08-30T00:06:00.000Z",
  );
  scheduler.close();
  store.close();
});

test("failed tasks persist an error and retry with backoff", async () => {
  const store = new PhiStore(tempDir());
  let now = new Date("2026-08-30T00:00:00.000Z");
  const scheduler = new SchedulerService(store, () => now);
  scheduler.registerHandler("fails", () => {
    throw new Error("planned failure");
  });
  scheduler.upsertTask({
    id: "test.failure",
    handler: "fails",
    schedule: { kind: "interval", everyMs: 1_000 },
  });
  now = new Date("2026-08-30T00:00:01.000Z");
  const originalError = console.error;
  console.error = () => undefined;
  try {
    expect(await scheduler.runDue(now)).toBe(1);
  } finally {
    console.error = originalError;
  }
  expect(scheduler.getTask("test.failure")).toMatchObject({
    nextRunAt: "2026-08-30T00:01:01.000Z",
    lastRunAt: null,
    lastError: "planned failure",
    failureCount: 1,
  });
  scheduler.close();
  store.close();
});

test("a running task cannot overlap with another due scan", async () => {
  const store = new PhiStore(tempDir());
  let now = new Date("2026-08-30T00:00:00.000Z");
  const scheduler = new SchedulerService(store, () => now);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  scheduler.registerHandler("slow", async () => {
    calls += 1;
    await blocked;
  });
  scheduler.upsertTask({
    id: "test.slow",
    handler: "slow",
    schedule: { kind: "interval", everyMs: 1_000 },
  });
  now = new Date("2026-08-30T00:00:01.000Z");
  const first = scheduler.runDue(now);
  expect(await scheduler.runDue(now)).toBe(0);
  release();
  expect(await first).toBe(1);
  expect(calls).toBe(1);
  scheduler.close();
  store.close();
});

test("a slow task does not block the wake for unrelated work", async () => {
  const store = new PhiStore(tempDir());
  const scheduler = new SchedulerService(store);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fastCalls = 0;
  scheduler.registerHandler("slow", async () => blocked);
  scheduler.registerHandler("fast", () => {
    fastCalls += 1;
  });
  scheduler.upsertTask({
    id: "test.slow-live",
    handler: "slow",
    schedule: { kind: "interval", everyMs: 60_000 },
    initialRun: "now",
  });
  scheduler.upsertTask({
    id: "test.fast-live",
    handler: "fast",
    schedule: { kind: "interval", everyMs: 15 },
  });
  scheduler.start();

  await Bun.sleep(50);
  expect(fastCalls).toBeGreaterThan(0);
  release();
  await Bun.sleep(5);
  scheduler.close();
  store.close();
});
