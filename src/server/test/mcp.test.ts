import { expect, test } from "bun:test";
import { PhiStore } from "@/core/store/store";
import { createMcpHandler } from "@/server/mcp";
import { McpTokenRegistry } from "@/server/mcp-token-registry";
import { tempDir } from "@/testing/tmpdir";

const MCP_PROTOCOL_VERSION = "2025-03-26";

function toolCall(
  handler: (req: Request) => Promise<Response>,
  token: string | null,
  id: number,
  content = "Hello from the agent",
): Promise<Response> {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "send_message", arguments: { content } },
      }),
    }),
  );
}

function listTools(
  handler: (req: Request) => Promise<Response>,
  token: string,
): Promise<Response> {
  return handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    }),
  );
}

function fixture() {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Start",
  });
  const tokens = new McpTokenRegistry();
  const token = tokens.mint({ threadId: thread.id, agentName: "default" });
  return {
    store,
    thread,
    tokens,
    token,
    handler: createMcpHandler(store, tokens),
  };
}

test("rejects missing and unknown bearer tokens", async () => {
  const { store, handler } = fixture();
  expect((await toolCall(handler, null, 1)).status).toBe(401);
  expect((await toolCall(handler, "unknown", 2)).status).toBe(401);
  store.close();
});

test("send_message posts one attributed bubble to the caller's thread", async () => {
  const { store, thread, tokens, token, handler } = fixture();
  const response = await toolCall(handler, token, 1, "Agent update");

  expect(response.status).toBe(200);
  const message = store.listMessages(thread.id).at(-1)!;
  expect(message.author).toBe("coordinator");
  expect(message.content).toBe("Agent update");
  expect(message.metadata).toEqual({ agent: "default" });
  expect(tokens.sendCount(token)).toBe(1);
  store.close();
});

test("advertises only send_message with the messaging contract", async () => {
  const { store, token, handler } = fixture();
  const response = await listTools(handler, token);
  const body = (await response.json()) as {
    result: { tools: Array<{ name: string; description: string }> };
  };

  expect(body.result.tools).toHaveLength(1);
  expect(body.result.tools[0]!.name).toBe("send_message");
  expect(body.result.tools[0]!.description).toContain("your only voice");
  store.close();
});

test("retries reuse a result while distinct calls create distinct bubbles", async () => {
  const { store, thread, token, handler } = fixture();

  await toolCall(handler, token, 7, "First");
  await toolCall(handler, token, 7, "First");
  await toolCall(handler, token, 8, "Second");

  expect(
    store
      .listMessages(thread.id)
      .filter((message) => message.author === "coordinator")
      .map((message) => message.content),
  ).toEqual(["First", "Second"]);
  store.close();
});
