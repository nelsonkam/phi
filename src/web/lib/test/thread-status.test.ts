import { expect, test } from "bun:test";
import { isThreadWorking, threadAttention } from "@/web/lib/thread-status";

test("isThreadWorking prefers live presence once ready", () => {
  expect(isThreadWorking({ ready: false, agent: null }, true)).toBe(true);
  expect(isThreadWorking({ ready: false, agent: null }, false)).toBe(false);
  expect(isThreadWorking({ ready: true, agent: "grok" }, false)).toBe(true);
  expect(isThreadWorking({ ready: true, agent: null }, true)).toBe(false);
});

test("threadAttention treats working as stronger than waiting", () => {
  expect(threadAttention(true, "agent", 1)).toBe("working");
  expect(threadAttention(true, "user", 0)).toBe("working");
  expect(threadAttention(false, "agent", 1)).toBe("waiting");
  expect(threadAttention(false, "user", 1)).toBeNull();
  expect(threadAttention(false, "system", 1)).toBeNull();
  expect(threadAttention(false, null, 1)).toBeNull();
});

test("waiting requires unread messages; working does not", () => {
  expect(threadAttention(false, "agent", 0)).toBeNull();
  expect(threadAttention(false, "agent", 3)).toBe("waiting");
  expect(threadAttention(true, "agent", 0)).toBe("working");
});
