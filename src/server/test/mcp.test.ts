import { expect, test } from "bun:test";
import { PhiStore } from "@/core/store/store";
import { createMcpHandler } from "@/server/mcp";
import { McpTokenRegistry } from "@/server/mcp-token-registry";
import { tempDir } from "@/testing/tmpdir";
import { ensureWorkspace } from "@/core/workspace";
import { writeAgent } from "@/core/agents/registry";
import type { Message } from "@/shared/types";
import type { SearchMessagesInput } from "@/core/search/types";

const MCP_PROTOCOL_VERSION = "2025-03-26";

function toolCall(
  handler: (req: Request) => Promise<Response>,
  token: string | null,
  id: number,
  content = "Hello from the agent",
  to?: string[],
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
        params: {
          name: "send_message",
          arguments: { content, ...(to ? { to } : {}) },
        },
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

function listAgentHarnesses(
  handler: (req: Request) => Promise<Response>,
  token: string,
  id: number,
  harness?: string,
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
        params: {
          name: "list_agent_harnesses",
          arguments: harness ? { harness } : {},
        },
      }),
    }),
  );
}

function fixture(onAgentMessage?: (message: Message, routedTo: string[]) => void) {
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
  const harnessCalls: Array<string | undefined> = [];
  const harnessCapabilities = {
    async list(harnessId?: string) {
      harnessCalls.push(harnessId);
      if (harnessId === "missing") throw new Error('unknown harness "missing"');
      return {
        harnesses: [
          {
            id: harnessId ?? "codex",
            name: "Codex",
            installed: true,
            available: true,
            installHint: "install codex",
            models: ["gpt-exact", "gpt-fast"],
            defaultModel: "gpt-exact",
            configOptions: [
              {
                id: "effort",
                type: "select" as const,
                defaultValue: "medium",
                values: ["low", "medium", "high"],
              },
            ],
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
    harnessCalls,
    workspace,
    handler: createMcpHandler(
      store,
      tokens,
      messageSearch,
      onAgentMessage,
      harnessCapabilities,
    ),
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
  expect(message.author).toBe("agent");
  expect(message.content).toBe("Agent update");
  expect(message.metadata).toEqual({
    agent: "default",
    mentions: [],
    routedTo: [],
  });
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

  expect(body.result.tools).toHaveLength(3);
  expect(body.result.tools[0]!.name).toBe("send_message");
  expect(body.result.tools[0]!.description).toContain("your only voice");
  expect(body.result.tools[0]!.inputSchema.properties.to).toBeDefined();
  const harnesses = body.result.tools[1]!;
  expect(harnesses.name).toBe("list_agent_harnesses");
  expect(harnesses.description).toContain("copied verbatim from ACP");
  expect(harnesses.inputSchema.properties.harness).toBeDefined();
  const search = body.result.tools[2]!;
  expect(search.name).toBe("search_messages");
  expect(search.inputSchema.properties.threadId).toBeUndefined();
  expect(search.inputSchema.properties.channelId).toBeUndefined();
  expect(search.inputSchema.properties.channel).toBeDefined();
  store.close();
});

test("list_agent_harnesses returns verbatim dispatch values", async () => {
  const { store, token, handler, harnessCalls } = fixture();
  const response = await listAgentHarnesses(handler, token, 20, "codex");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(JSON.parse(body.result.content[0]!.text)).toEqual({
    harnesses: [
      {
        id: "codex",
        name: "Codex",
        installed: true,
        available: true,
        installHint: "install codex",
        models: ["gpt-exact", "gpt-fast"],
        defaultModel: "gpt-exact",
        configOptions: [
          {
            id: "effort",
            type: "select",
            defaultValue: "medium",
            values: ["low", "medium", "high"],
          },
        ],
      },
    ],
  });
  expect(harnessCalls).toEqual(["codex"]);

  const invalid = await listAgentHarnesses(handler, token, 21, "missing");
  const invalidBody = (await invalid.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(invalidBody.result.isError).toBe(true);
  expect(invalidBody.result.content[0]!.text).toContain("unknown harness");
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
      .filter((message) => message.author === "agent")
      .map((message) => message.content),
  ).toEqual(["First", "Second"]);
  store.close();
});

test("send_message validates and routes explicit agent handoffs", async () => {
  const routed: Array<{ message: Message; routedTo: string[] }> = [];
  const { store, thread, token, handler, workspace } = fixture(
    (message, routedTo) => routed.push({ message, routedTo }),
  );
  ensureWorkspace(workspace.rootPath);
  await writeAgent(workspace.rootPath, "reviewer", {
    harness: "codex",
    instructions: "Review the work.",
  });

  const response = await toolCall(handler, token, 31, "Plan is ready", [
    "reviewer",
    "default",
  ]);
  expect(response.status).toBe(200);
  const message = store.listMessages(thread.id).at(-1)!;
  expect(message.metadata).toEqual({
    agent: "default",
    mentions: [],
    routedTo: ["reviewer"],
  });
  expect(routed).toEqual([{ message, routedTo: ["reviewer"] }]);

  const before = store.listMessages(thread.id).length;
  const invalid = await toolCall(handler, token, 32, "handoff", ["missing"]);
  const body = (await invalid.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0]!.text).toContain("unknown agent: @missing");
  expect(store.listMessages(thread.id)).toHaveLength(before);
  store.close();
});
