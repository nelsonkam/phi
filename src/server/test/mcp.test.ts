import { expect, test } from "bun:test";
import { PhiStore } from "@/core/store/store";
import { createMcpHandler } from "@/server/mcp";
import { McpTokenRegistry } from "@/server/mcp-token-registry";
import { tempDir } from "@/testing/tmpdir";
import type { SearchMessagesInput } from "@/core/search/types";

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

function searchMessages(
  handler: (req: Request) => Promise<Response>,
  token: string,
  id: number,
  args: Record<string, unknown>,
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
        id,
        method: "tools/call",
        params: { name: "search_messages", arguments: args },
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
  const searchCalls: Array<{
    workspaceId: string;
    input: SearchMessagesInput;
  }> = [];
  const messageSearch = {
    async search(workspaceId: string, input: SearchMessagesInput) {
      searchCalls.push({ workspaceId, input });
      return {
        semanticAvailable: true,
        results: [
          {
            messageId: "msg_result",
            workspaceId,
            channel: channel.name,
            threadId: thread.id,
            author: "user" as const,
            content: "Matched message",
            snippet: "Matched message",
            createdAt: new Date(0).toISOString(),
            score: 1,
            matchedBy: ["semantic" as const],
          },
        ],
      };
    },
  };
  return {
    store,
    thread,
    tokens,
    token,
    searchCalls,
    handler: createMcpHandler(store, tokens, messageSearch),
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

test("advertises messaging and workspace search without a thread argument", async () => {
  const { store, token, handler } = fixture();
  const response = await listTools(handler, token);
  const body = (await response.json()) as {
    result: {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: { properties: Record<string, unknown> };
      }>;
    };
  };

  expect(body.result.tools).toHaveLength(2);
  expect(body.result.tools[0]!.name).toBe("send_message");
  expect(body.result.tools[0]!.description).toContain("your only voice");
  const search = body.result.tools[1]!;
  expect(search.name).toBe("search_messages");
  expect(search.inputSchema.properties.threadId).toBeUndefined();
  expect(search.inputSchema.properties.channelId).toBeUndefined();
  expect(search.inputSchema.properties.channel).toBeDefined();
  store.close();
});

test("search_messages derives the workspace from the caller token", async () => {
  const { store, token, handler, searchCalls } = fixture();
  const response = await searchMessages(handler, token, 19, {
    query: "prior authentication decision",
    channel: "GENERAL",
    limit: 3,
  });
  expect(response.status).toBe(200);
  expect(searchCalls).toEqual([
    {
      workspaceId: store.defaultWorkspace().id,
      input: {
        query: "prior authentication decision",
        channel: "GENERAL",
        limit: 3,
      },
    },
  ]);
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(JSON.parse(body.result.content[0]!.text).results[0].content).toBe(
    "Matched message",
  );
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
