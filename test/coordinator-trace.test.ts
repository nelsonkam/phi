import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { captureCoordinatorEvent } from "../src/coordinator/runtime.ts";
import { CoordinatorTraceStore } from "../src/coordinator/trace.ts";
import { TurnContext } from "../src/coordinator/turn-context.ts";
import type { EventRecord } from "../src/domain.ts";

function event(value: unknown): AgentSessionEvent {
  return value as AgentSessionEvent;
}

test("coordinator traces project public Pi session events", () => {
  const traces = new CoordinatorTraceStore();
  captureCoordinatorEvent(
    event({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "list_workers",
      args: { ready: true },
    }),
    traces,
  );
  captureCoordinatorEvent(
    event({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "list_workers",
      result: { content: [{ type: "text", text: "four workers" }] },
      isError: false,
    }),
    traces,
  );
  captureCoordinatorEvent(
    event({
      type: "message_update",
      message: {},
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Choose the ready adapter.",
        partial: {
          timestamp: 1_700_000_000_000,
          content: [
            { type: "thinking", thinking: "Choose the ready adapter." },
          ],
        },
      },
    }),
    traces,
  );
  captureCoordinatorEvent(
    event({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 1_700_000_000_001,
        stopReason: "stop",
        content: [{ type: "text", text: "Coordinator turn complete." }],
      },
    }),
    traces,
  );

  expect(traces.list().map((entry) => entry.kind)).toEqual([
    "reasoning",
    "output",
    "tool",
  ]);
  const tool = traces.get("tool:call-1");
  expect(tool?.state).toBe("completed");
  expect(tool?.content).toContain('"ready": true');
  expect(tool?.content).toContain("four workers");
});

test("coordinator traces omit redacted reasoning", () => {
  const traces = new CoordinatorTraceStore();
  captureCoordinatorEvent(
    event({
      type: "message_update",
      message: {},
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "opaque",
        partial: {
          timestamp: 1_700_000_000_000,
          content: [{ type: "thinking", thinking: "", redacted: true }],
        },
      },
    }),
    traces,
  );
  expect(traces.list()).toEqual([]);
});

test("coordinator tools cannot run outside a durable turn", async () => {
  const turn = new TurnContext();
  const event = {
    id: "event",
    source: "user",
    kind: "user_message",
  } as EventRecord;
  await turn.run(event, async () => {
    expect(turn.require().id).toBe("event");
  });
  expect(() => turn.require()).toThrow("outside a durable coordinator turn");
});
