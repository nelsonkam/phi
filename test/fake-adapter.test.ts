import { describe, expect, test } from "bun:test";
import {
  WorkerAdapterRegistry,
  type WorkerEvent,
} from "../src/workers/adapter.ts";
import { FakeWorkerAdapter } from "../src/workers/fake.ts";

async function collect(stream: AsyncIterable<WorkerEvent>) {
  const events: WorkerEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("fake WorkerAdapter conformance", () => {
  test("launch is dispatch-key idempotent and streams a terminal event", async () => {
    const adapter = new FakeWorkerAdapter();
    const input = {
      jobId: "job",
      dispatchKey: "dispatch",
      prompt: "hello [fake:duplicate]",
      cwd: process.cwd(),
      mode: "mutating" as const,
      model: "fake-deterministic",
    };
    const first = await adapter.launch(input);
    const second = await adapter.launch(input);
    expect(second.externalRunId).toBe(first.externalRunId);
    const events = await collect(adapter.watch(first.externalRunId));
    expect(events.some((event) => event.type === "activity")).toBeTrue();
    expect(events.filter((event) => event.type === "completed").length).toBe(2);
    expect(
      events.find((event) => event.type === "completed")?.data?.model,
    ).toBe("fake-deterministic");
    expect(
      await adapter.reconcile({ dispatchKey: input.dispatchKey }),
    ).toMatchObject({ state: "terminal" });
  });

  test("registry validates per-job model and effort selections", async () => {
    const registry = new WorkerAdapterRegistry();
    registry.register(new FakeWorkerAdapter());
    expect(await registry.resolveSelection("fake", {})).toEqual({
      model: "fake-deterministic",
    });
    await expect(
      registry.resolveSelection("fake", { model: "invented" }),
    ).rejects.toThrow("not selectable");
    await expect(
      registry.resolveSelection("fake", { effort: "high" }),
    ).rejects.toThrow("not supported");
  });

  test("needs_input accepts in-run follow-up", async () => {
    const adapter = new FakeWorkerAdapter();
    const launched = await adapter.launch({
      dispatchKey: "followup",
      prompt: "[fake:needs_input]",
    });
    const events: WorkerEvent[] = [];
    for await (const event of adapter.watch(launched.externalRunId)) {
      events.push(event);
      if (event.type === "needs_input")
        await adapter.followUp(event.continuationHandle, "forty-two");
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "activity",
        message: "received: forty-two",
      }),
    );
    expect(events.at(-1)?.type).toBe("completed");
  });

  test("cancellation closes the stream durably at a terminal event", async () => {
    const adapter = new FakeWorkerAdapter();
    const launched = await adapter.launch({
      dispatchKey: "cancel",
      prompt: "[fake:delay=1000]",
    });
    await adapter.cancel(launched.externalRunId);
    const events = await collect(adapter.watch(launched.externalRunId));
    expect(events.at(-1)?.type).toBe("cancelled");
  });
});
