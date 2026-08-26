import { expect, test } from "bun:test";
import { McpTokenRegistry } from "@/server/mcp-token-registry";

test("tokens carry caller identity and revoke cleanly", () => {
  const registry = new McpTokenRegistry();
  const token = registry.mint({ threadId: "thread-1", agentName: "default" });

  expect(registry.lookup(token)).toEqual({
    threadId: "thread-1",
    agentName: "default",
  });
  registry.revoke(token);
  expect(registry.lookup(token)).toBeNull();
});

test("tracks sends per turn", () => {
  const registry = new McpTokenRegistry();
  const token = registry.mint({ threadId: "thread-1", agentName: "default" });

  registry.recordSend(token);
  expect(registry.sendCount(token)).toBe(1);
  registry.beginTurn(token);
  expect(registry.sendCount(token)).toBe(0);
});

test("deduplicates successful calls by operation and request id", async () => {
  const registry = new McpTokenRegistry();
  const token = registry.mint({ threadId: "thread-1", agentName: "default" });
  let runs = 0;
  const call = () =>
    registry.runOnce(token, "send_message", 7, () => {
      runs += 1;
      return { ok: true };
    });

  expect(await call()).toEqual({ ok: true });
  expect(await call()).toEqual({ ok: true });
  expect(runs).toBe(1);
});
