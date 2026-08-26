import { expect, test } from "bun:test";
import type { Agent } from "@/shared/types";
import { threadUntaggedAgent } from "@/web/lib/thread-agent";

const defaultAgent = {
  name: "default",
  role: "default",
} as Agent;

const researcher = {
  name: "researcher",
  role: null,
} as Agent;

test("uses the root message routed agent when present", () => {
  expect(
    threadUntaggedAgent(
      { metadata: { routedTo: ["researcher"] } },
      [defaultAgent, researcher],
    ),
  ).toBe("researcher");
});

test("falls back to the workspace default when the root has no route", () => {
  expect(threadUntaggedAgent({ metadata: {} }, [defaultAgent, researcher])).toBe(
    "default",
  );
  expect(threadUntaggedAgent(null, [defaultAgent])).toBe("default");
});

test("returns null when neither a route nor a default agent exists", () => {
  expect(threadUntaggedAgent({ metadata: {} }, [researcher])).toBeNull();
  expect(threadUntaggedAgent(undefined, undefined)).toBeNull();
});

test("degrades a deleted routed agent to the workspace default", () => {
  expect(
    threadUntaggedAgent(
      { metadata: { routedTo: ["ghost"] } },
      [defaultAgent, researcher],
    ),
  ).toBe("default");
  expect(
    threadUntaggedAgent({ metadata: { routedTo: ["ghost"] } }, [researcher]),
  ).toBeNull();
});
