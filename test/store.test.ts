import { afterEach, describe, expect, test } from "bun:test";
import { schemaVersion } from "../src/db/database.ts";
import { StateTransitionError } from "../src/errors.ts";
import {
  acceptJob,
  sourceEvent,
  testFixture,
  type TestFixture,
} from "./helpers.ts";

let fixtures: TestFixture[] = [];
const fixture = () => {
  const value = testFixture();
  fixtures.push(value);
  return value;
};
afterEach(() => {
  for (const item of fixtures) item.database.close();
  fixtures = [];
});

describe("durable repository invariants", () => {
  test("outbox obligations prevent event acknowledgement", () => {
    const { store } = fixture();
    const event = store.acceptUserMessage("hello");
    expect(store.claimNextEvent()?.id).toBe(event.id);
    expect(() => store.markEventProcessed(event.id)).toThrow(
      StateTransitionError,
    );
    store.putOutbox({
      eventId: event.id,
      kind: "ack",
      content: "accepted",
      idempotencyKey: `message:event:${event.id}:primary`,
    });
    store.markEventProcessed(event.id);
    expect(store.getEvent(event.id).processedAt).not.toBeNull();
  });

  test("user events outrank visible worker events", () => {
    const item = fixture();
    const source = sourceEvent(item, "source");
    const job = item.store.acceptJob({
      workspaceId: item.workspaceId,
      sourceEventId: source.id,
      adapter: "fake",
      key: "priority-job",
      prompt: "test",
      mode: "read_only",
    }).job;
    const claimed = item.store.claimNextJob(null)!;
    item.store.recordRunning(claimed.id, "fake-priority", "fake-priority");
    item.store.recordNeedsInput({
      jobId: job.id,
      dedupeKey: "worker:fake:priority:question",
      payload: { question: "answer?" },
      continuationHandle: "fake-priority",
    });
    const newerUser = sourceEvent(item, "new user input");
    const firstUser = item.store.claimNextEvent()!;
    expect([source.id, newerUser.id]).toContain(firstUser.id);
    item.store.putOutbox({
      eventId: firstUser.id,
      kind: "ack",
      content: "source",
      idempotencyKey: `source:${firstUser.id}`,
    });
    item.store.markEventProcessed(firstUser.id);
    const secondUser = item.store.claimNextEvent()!;
    expect([source.id, newerUser.id]).toContain(secondUser.id);
    expect(secondUser.id).not.toBe(firstUser.id);
  });

  test("terminal events remain invisible until job finalization", () => {
    const item = fixture();
    const job = acceptJob(item);
    const running = item.store.recordRunning(
      item.store.claimNextJob("start")!.id,
      "fake-terminal",
    );
    const begun = item.store.beginCompletion({
      jobId: running.id,
      kind: "worker_completed",
      dedupeKey: "worker:fake:terminal:done",
      payload: { summary: "done" },
    });
    expect(begun.event.visibleAt).toBeNull();
    expect(item.store.getJob(job.id).status).toBe("completing");
    item.store.finalizeCompletion({
      jobId: job.id,
      eventId: begun.event.id,
      status: "completed",
      observedTerminalCommit: "terminal",
    });
    expect(item.store.getEvent(begun.event.id).visibleAt).not.toBeNull();
    expect(item.store.getJob(job.id).status).toBe("completed");
  });

  test("schema-backed dedupe and dispatch idempotency return one row", () => {
    const item = fixture();
    const source = sourceEvent(item);
    const first = item.store.acceptJob({
      workspaceId: item.workspaceId,
      sourceEventId: source.id,
      adapter: "fake",
      key: "same-dispatch",
      prompt: "one",
      mode: "mutating",
      model: "fake-deterministic",
      effort: "low",
    });
    const second = item.store.acceptJob({
      workspaceId: item.workspaceId,
      sourceEventId: source.id,
      adapter: "fake",
      key: "same-dispatch",
      prompt: "two",
      mode: "read_only",
    });
    expect(first.created).toBeTrue();
    expect(second.created).toBeFalse();
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.model).toBe("fake-deterministic");
    expect(second.job.effort).toBe("low");
    const running = item.store.recordRunning(
      item.store.claimNextJob(null)!.id,
      "fake-dedupe",
    );
    const one = item.store.recordProgress({
      jobId: running.id,
      kind: "worker_status",
      dedupeKey: "worker:fake:dedupe:native-1",
      payload: { message: "one" },
    });
    const two = item.store.recordProgress({
      jobId: running.id,
      kind: "worker_status",
      dedupeKey: "worker:fake:dedupe:native-1",
      payload: { message: "replay" },
    });
    expect(two.id).toBe(one.id);
    expect(item.store.listJobEvents(running.id)).toEqual([
      expect.objectContaining({ id: one.id, kind: "worker_status" }),
    ]);
    expect(
      item.store.raw
        .query("SELECT sql FROM sqlite_master WHERE name='events_dedupe'")
        .get(),
    ).not.toBeNull();
  });

  test("schema migration persists root model and effort selection", () => {
    const item = fixture();
    const job = acceptJob(item, {
      model: "test-model",
      effort: "high",
    });
    expect(job.model).toBe("test-model");
    expect(job.effort).toBe("high");
    expect(
      item.store.raw
        .query("SELECT max(version) AS version FROM schema_migrations")
        .get(),
    ).toEqual({ version: schemaVersion });
  });

  test("mutating and read-only jobs are claimed without leases", () => {
    const item = fixture();
    acceptJob(item, { key: "writer-1", mode: "mutating" });
    acceptJob(item, { key: "writer-2", mode: "mutating" });
    acceptJob(item, { key: "reader", mode: "read_only" });
    const claimed = [
      item.store.claimNextJob("a"),
      item.store.claimNextJob("a"),
      item.store.claimNextJob("a"),
    ];
    expect(claimed.every(Boolean)).toBeTrue();
    expect(item.store.claimNextJob("a")).toBeNull();
    const modes = item.store.listJobs(["launching"]).map((job) => job.mode);
    expect(modes.filter((mode) => mode === "mutating")).toHaveLength(2);
    expect(modes.filter((mode) => mode === "read_only")).toHaveLength(1);
  });

  test("crash recovery resets event claims and makes follow-up ambiguity explicit", () => {
    const item = fixture();
    const source = sourceEvent(item);
    item.store.putOutbox({
      eventId: source.id,
      kind: "ack",
      content: "ack",
      idempotencyKey: "recovery-outbox",
    });
    expect(item.store.claimNextEvent()?.id).toBe(source.id);
    const job = item.store.acceptJob({
      workspaceId: item.workspaceId,
      sourceEventId: source.id,
      adapter: "fake",
      key: "recovery-job",
      prompt: "test",
      mode: "read_only",
    }).job;
    item.store.recordRunning(
      item.store.claimNextJob(null)!.id,
      "fake-recovery",
      "fake-recovery",
    );
    item.store.recordNeedsInput({
      jobId: job.id,
      dedupeKey: "worker:fake:recovery:question",
      payload: { question: "answer" },
      continuationHandle: "fake-recovery",
    });
    const follow = item.store.enqueueFollowUp({
      jobId: job.id,
      sourceEventId: source.id,
      key: "recovery-follow",
      content: "answer",
    }).followUp;
    expect(item.store.claimFollowUp()?.id).toBe(follow.id);
    item.store.recoverClaims();
    expect(item.store.getEvent(source.id).processingStartedAt).toBeNull();
    expect(item.store.getFollowUp(follow.id).status).toBe("unknown");
  });
});
