import { expect, test } from "bun:test";
import type { Agent, Message } from "@/shared/types";
import { threadUntaggedAgent } from "@/web/lib/thread-agent";

const defaultAgent = {
  name: "default",
  role: "default",
} as Agent;

const researcher = {
  name: "researcher",
  role: null,
} as Agent;

const codex = {
  name: "codex",
  role: null,
} as Agent;

type Msg = Pick<Message, "author" | "metadata">;

const user = (metadata: Msg["metadata"] = {}): Msg => ({
  author: "user",
  metadata,
});

const agentReply = (agent: string): Msg => ({
  author: "agent",
  metadata: { agent },
});

test("routes to the last agent that answered", () => {
  expect(
    threadUntaggedAgent(
      [
        user({ routedTo: ["researcher"] }),
        agentReply("researcher"),
        agentReply("codex"),
        user(),
      ],
      [defaultAgent, researcher, codex],
    ),
  ).toBe("codex");
});

test("uses the root message routed agent before any agent has replied", () => {
  expect(
    threadUntaggedAgent(
      [user({ routedTo: ["researcher"] })],
      [defaultAgent, researcher],
    ),
  ).toBe("researcher");
});

test("falls back to the workspace default when the root has no route", () => {
  expect(
    threadUntaggedAgent([user()], [defaultAgent, researcher]),
  ).toBe("default");
  expect(threadUntaggedAgent(null, [defaultAgent])).toBe("default");
});

test("returns null when neither a route nor a default agent exists", () => {
  expect(threadUntaggedAgent([user()], [researcher])).toBeNull();
  expect(threadUntaggedAgent(undefined, undefined)).toBeNull();
});

test("degrades a deleted agent to the workspace default", () => {
  expect(
    threadUntaggedAgent(
      [user({ routedTo: ["ghost"] })],
      [defaultAgent, researcher],
    ),
  ).toBe("default");
  expect(
    threadUntaggedAgent([user({ routedTo: ["ghost"] })], [researcher]),
  ).toBeNull();
  expect(
    threadUntaggedAgent(
      [user({ routedTo: ["researcher"] }), agentReply("ghost")],
      [defaultAgent, researcher],
    ),
  ).toBe("default");
});

test("a deleted primary degrades to default even with a known speculative", () => {
  // Mirrors the server: only routedTo[0] counts, so a surviving speculative
  // recipient must not claim the untagged reply.
  expect(
    threadUntaggedAgent(
      [user({ routedTo: ["ghost", "researcher"] })],
      [defaultAgent, researcher],
    ),
  ).toBe("default");
});
