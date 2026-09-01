import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PhiStore } from "@/core/store/store";
import { uploadsPath } from "@/core/paths";
import { createMcpHandler } from "@/server/mcp";
import { McpTokenRegistry } from "@/server/mcp-token-registry";
import { tempDir } from "@/testing/tmpdir";
import { ensureWorkspace } from "@/core/workspace";
import { writeAgent } from "@/core/agents/registry";
import type { Message } from "@/shared/types";
import type {
  MessageSearchContext,
  SearchMessagesInput,
} from "@/core/search/types";

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

function createChannel(
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
        params: { name: "create_channel", arguments: args },
      }),
    }),
  );
}

function createThread(
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
        params: { name: "create_thread", arguments: args },
      }),
    }),
  );
}

function callTool(
  handler: (req: Request) => Promise<Response>,
  token: string,
  id: number,
  name: string,
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
        params: { name, arguments: args },
      }),
    }),
  );
}

function fixture(onAgentMessage?: (message: Message, routedTo: string[]) => void) {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  ensureWorkspace(workspace.rootPath);
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
    context: MessageSearchContext;
  }> = [];
  const messageSearch = {
    async search(
      workspaceId: string,
      input: SearchMessagesInput,
      context: MessageSearchContext,
    ) {
      searchCalls.push({ workspaceId, input, context });
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
            matchedBy: ["semantic" as const],
            threadHitCount: 1,
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
  const subscriptionCalls: Array<{
    threadId: string;
    resource: string;
    events?: string[];
  }> = [];
  const subscriptions = {
    async subscribe(threadId: string, resource: string, events?: string[]) {
      subscriptionCalls.push({ threadId, resource, events });
      return {
        created: true,
        subscription: {
          id: "sub_test",
          provider: "github",
          resourceKind: "pull_request",
          resourceKey: "openai/phi#42",
          resourceUrl: "https://github.com/openai/phi/pull/42",
          events: events ?? ["state_changed"],
        },
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
    subscriptionCalls,
    workspace,
    handler: createMcpHandler(
      store,
      tokens,
      messageSearch,
      onAgentMessage,
      harnessCapabilities,
      subscriptions,
    ),
  };
}

function attachFile(
  store: PhiStore,
  id: string,
  filename: string,
  contentType: string,
  body: string | Uint8Array,
) {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  mkdirSync(uploadsPath(store.rootPath), { recursive: true });
  writeFileSync(join(uploadsPath(store.rootPath), id), bytes);
  return store.createAttachment({
    id,
    workspaceId: store.defaultWorkspace().id,
    filename,
    contentType,
    byteSize: bytes.byteLength,
  });
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

  expect(body.result.tools).toHaveLength(11);
  expect(body.result.tools[0]!.name).toBe("send_message");
  expect(body.result.tools[0]!.description).toContain("your only voice");
  expect(body.result.tools[0]!.description).toContain(
    "a doc under the channel plus a linked summary",
  );
  expect(body.result.tools[0]!.description).toContain(
    "earned by enumerable content",
  );
  expect(body.result.tools[0]!.inputSchema.properties.to).toBeDefined();
  expect(body.result.tools[0]!.inputSchema.properties.thread_id).toBeDefined();
  const harnesses = body.result.tools[1]!;
  expect(harnesses.name).toBe("list_agent_harnesses");
  expect(harnesses.description).toContain("copied verbatim from ACP");
  expect(harnesses.inputSchema.properties.harness).toBeDefined();
  const create = body.result.tools[2]!;
  expect(create.name).toBe("create_channel");
  expect(create.inputSchema.properties.folders).toBeDefined();
  const createThreadTool = body.result.tools[3]!;
  expect(createThreadTool.name).toBe("create_thread");
  expect(createThreadTool.inputSchema.properties.channel).toBeDefined();
  expect(createThreadTool.inputSchema.properties.to).toBeDefined();
  const listChannelThreads = body.result.tools[4]!;
  expect(listChannelThreads.name).toBe("list_channel_threads");
  expect(listChannelThreads.inputSchema.properties.channel).toBeDefined();
  const getCheckpoint = body.result.tools[5]!;
  expect(getCheckpoint.name).toBe("get_reflection_checkpoint");
  expect(getCheckpoint.inputSchema.properties.channel).toBeDefined();
  const setCheckpoint = body.result.tools[6]!;
  expect(setCheckpoint.name).toBe("set_reflection_checkpoint");
  expect(setCheckpoint.inputSchema.properties.channel).toBeDefined();
  expect(setCheckpoint.inputSchema.properties.through_seq).toBeDefined();
  const readThread = body.result.tools[7]!;
  expect(readThread.name).toBe("read_thread");
  expect(readThread.inputSchema.properties.thread_id).toBeDefined();
  const readAttachment = body.result.tools[8]!;
  expect(readAttachment.name).toBe("read_attachment");
  expect(readAttachment.inputSchema.properties.attachment_id).toBeDefined();
  const search = body.result.tools[9]!;
  expect(search.name).toBe("search_messages");
  expect(search.inputSchema.properties.threadId).toBeUndefined();
  expect(search.inputSchema.properties.channelId).toBeUndefined();
  expect(search.inputSchema.properties.channel).toBeDefined();
  expect(search.inputSchema.properties.includeCurrentThread).toBeDefined();
  expect(search.inputSchema.properties.author).toBeDefined();
  const subscribe = body.result.tools[10]!;
  expect(subscribe.name).toBe("subscribe");
  expect(subscribe.description).toContain("GitHub pull requests");
  expect(subscribe.inputSchema.properties.resource).toBeDefined();
  expect(subscribe.inputSchema.properties.events).toMatchObject({
    type: "array",
    minItems: 1,
    uniqueItems: true,
  });
  expect(
    (
      subscribe.inputSchema.properties.events as {
        items: { enum: string[] };
      }
    ).items.enum,
  ).toEqual([
    "state_changed",
    "draft_changed",
    "review_decision_changed",
    "checks_failed",
    "checks_passed",
    "new_review",
    "new_comment",
    "new_commit",
    "labels_changed",
    "assignees_changed",
    "mergeability_changed",
  ]);
  store.close();
});

test("subscribe binds a resource to the caller's current thread", async () => {
  const { store, thread, token, handler, subscriptionCalls } = fixture();
  const response = await callTool(handler, token, 2, "subscribe", {
    resource: "openai/phi#42",
    events: ["state_changed", "checks_failed"],
  });
  const body = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(body.result.isError).toBeUndefined();
  expect(subscriptionCalls).toEqual([
    {
      threadId: thread.id,
      resource: "openai/phi#42",
      events: ["state_changed", "checks_failed"],
    },
  ]);
  expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({
    created: true,
    subscription: {
      id: "sub_test",
      resourceKey: "openai/phi#42",
      events: ["state_changed", "checks_failed"],
    },
  });
  store.close();
});

test("list_channel_threads surveys a channel and read_thread reads any workspace thread", async () => {
  const { store, thread, tokens, handler, workspace } = fixture();
  const channel = store.getChannel(thread.channelId)!;
  const attachment = attachFile(
    store,
    `att_${"9".repeat(32)}`,
    "decision.txt",
    "text/plain",
    "durable decision\n",
  );
  store.appendMessage(thread.id, {
    author: "agent",
    kind: "message",
    content: "Acknowledged",
    metadata: { agent: "default", attachments: [attachment] },
  });
  store.setThreadOutcome(thread.id, "worked");
  const second = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Use compact titles",
  });
  const otherChannel = store.createChannel(workspace.id, { name: "private" });
  const outside = store.createThread(otherChannel.id, {
    author: "user",
    kind: "message",
    content: "Outside the source channel",
  });
  const reflectionChannel = store.createChannel(workspace.id, {
    name: "reflection",
  });
  const run = store.createThread(reflectionChannel.id, {
    author: "system",
    kind: "reflection",
    content: "Inspect the source window",
    metadata: { reflection: true },
  });
  const runToken = tokens.mint({
    threadId: run.thread.id,
    agentName: "default",
  });

  const listedTools = (await (await listTools(handler, runToken)).json()) as {
    result: { tools: Array<{ name: string }> };
  };
  const toolNames = listedTools.result.tools.map((tool) => tool.name);
  expect(toolNames).toContain("list_channel_threads");
  expect(toolNames).toContain("get_reflection_checkpoint");
  expect(toolNames).toContain("set_reflection_checkpoint");
  expect(toolNames).toContain("search_messages");
  expect(toolNames).not.toContain("read_channel_thread");

  const listed = await callTool(
    handler,
    runToken,
    60,
    "list_channel_threads",
    {
      channel: channel.name,
      from_seq: store.rootMessage(thread.id)!.seq,
      through_seq: second.message.seq,
    },
  );
  const listedBody = (await listed.json()) as {
    result: { content: Array<{ text: string }> };
  };
  const payload = JSON.parse(listedBody.result.content[0]!.text) as {
    channel: string;
    threads: Array<{
      threadId: string;
      outcome: string | null;
      messageCount: number;
    }>;
  };
  expect(payload.channel).toBe(channel.name);
  expect(payload.threads).toHaveLength(2);
  expect(payload.threads[0]).toMatchObject({
    threadId: thread.id,
    outcome: "worked",
    messageCount: 2,
  });

  // The run's own channel is surveyable, including its reflection thread.
  const ownChannel = await callTool(
    handler,
    runToken,
    61,
    "list_channel_threads",
    {},
  );
  const ownBody = (await ownChannel.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(
    (JSON.parse(ownBody.result.content[0]!.text) as {
      threads: Array<{ threadId: string }>;
    }).threads,
  ).toEqual([expect.objectContaining({ threadId: run.thread.id })]);

  const seqBounded = await callTool(
    handler,
    runToken,
    62,
    "list_channel_threads",
    {
      channel: channel.name,
      through_seq: store.rootMessage(thread.id)!.seq,
    },
  );
  const seqBody = (await seqBounded.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(
    (JSON.parse(seqBody.result.content[0]!.text) as {
      threads: Array<{ messageCount: number }>;
    }).threads,
  ).toEqual([expect.objectContaining({ threadId: thread.id, messageCount: 1 })]);

  const crossChannel = await callTool(handler, runToken, 63, "read_thread", {
    thread_id: outside.thread.id,
  });
  const crossBody = (await crossChannel.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(
    (JSON.parse(crossBody.result.content[0]!.text) as {
      messages: Array<{ content: string }>;
    }).messages.map((message) => message.content),
  ).toEqual(["Outside the source channel"]);

  const unknownThread = await callTool(handler, runToken, 64, "read_thread", {
    thread_id: "th_missing",
  });
  expect(
    ((await unknownThread.json()) as { result: { isError: boolean } }).result
      .isError,
  ).toBe(true);

  const listedCheckpoints = await callTool(
    handler,
    runToken,
    66,
    "get_reflection_checkpoint",
    {},
  );
  const listedCheckpointBody = (await listedCheckpoints.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(
    JSON.parse(listedCheckpointBody.result.content[0]!.text) as {
      checkpoints: Array<{ channel: string; throughSeq: number }>;
    },
  ).toMatchObject({
    checkpoints: expect.arrayContaining([
      { channel: channel.name, throughSeq: 0 },
      { channel: reflectionChannel.name, throughSeq: 0 },
    ]),
  });

  const setCheckpoint = await callTool(
    handler,
    runToken,
    67,
    "set_reflection_checkpoint",
    { channel: channel.name, through_seq: second.message.seq },
  );
  const setCheckpointBody = (await setCheckpoint.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(JSON.parse(setCheckpointBody.result.content[0]!.text)).toEqual({
    channel: channel.name,
    throughSeq: second.message.seq,
  });
  expect(store.getReflectionCheckpoint(channel.id)).toBe(second.message.seq);

  const staleWrite = await callTool(
    handler,
    runToken,
    69,
    "set_reflection_checkpoint",
    { channel: channel.name, through_seq: 1 },
  );
  const staleBody = (await staleWrite.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(JSON.parse(staleBody.result.content[0]!.text)).toEqual({
    channel: channel.name,
    throughSeq: second.message.seq,
  });
  expect(store.getReflectionCheckpoint(channel.id)).toBe(second.message.seq);

  const pastSeq = await callTool(
    handler,
    runToken,
    68,
    "set_reflection_checkpoint",
    { channel: channel.name, through_seq: second.message.seq + 10 },
  );
  expect(
    ((await pastSeq.json()) as { result: { isError: boolean } }).result.isError,
  ).toBe(true);

  const attachmentRead = await callTool(
    handler,
    runToken,
    65,
    "read_attachment",
    { attachment_id: attachment.id },
  );
  const attachmentBody = (await attachmentRead.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(
    (JSON.parse(attachmentBody.result.content[0]!.text) as { content: string })
      .content,
  ).toBe("durable decision\n");
  store.close();
});

test("create_channel attaches canonical external folders in caller workspace", async () => {
  const { store, token, handler, workspace } = fixture();
  const first = tempDir();
  const second = tempDir();
  const response = await createChannel(handler, token, 40, {
    name: "release-work",
    purpose: "Prepare the release",
    folders: [first, second, first],
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }> };
  };
  const created = JSON.parse(body.result.content[0]!.text).channel;
  expect(created).toMatchObject({
    workspaceId: workspace.id,
    name: "release-work",
    purpose: "Prepare the release",
    folders: [realpathSync(first), realpathSync(second)],
  });
  expect(store.getChannel(created.id)).toEqual(created);

  const duplicate = await createChannel(handler, token, 41, {
    name: "release-work",
  });
  const duplicateBody = (await duplicate.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(duplicateBody.result.isError).toBe(true);
  expect(duplicateBody.result.content[0]!.text).toContain("already exists");
  store.close();
});

test("create_channel rejects relative, missing, and phi-owned folders", async () => {
  const { store, token, handler, workspace } = fixture();
  for (const [id, folder, message] of [
    [50, "relative/path", "must be absolute"],
    [51, "/definitely/missing/phi-folder", "does not exist"],
    [52, workspace.rootPath, "outside phi's workspace"],
  ] as const) {
    const response = await createChannel(handler, token, id, {
      name: `invalid-${id}`,
      folders: [folder],
    });
    const body = (await response.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain(message);
  }
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
    includeCurrentThread: true,
    author: "user",
  });
  expect(response.status).toBe(200);
  expect(searchCalls).toEqual([
    {
      workspaceId: store.defaultWorkspace().id,
      input: {
        query: "prior authentication decision",
        channel: "GENERAL",
        limit: 3,
        includeCurrentThread: true,
        author: "user",
      },
      context: { currentThreadId: expect.any(String) },
    },
  ]);
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }> };
  };
  const payload = JSON.parse(body.result.content[0]!.text);
  expect(payload.results[0].content).toBe("Matched message");
  expect(payload.results[0].matchedBy).toEqual(["semantic"]);
  expect(payload.results[0]).not.toHaveProperty("score");
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

test("send_message flags a dropped self-route while the turn is still live", async () => {
  const routed: Array<{ message: Message; routedTo: string[] }> = [];
  const { store, thread, token, handler, workspace } = fixture(
    (message, routedTo) => routed.push({ message, routedTo }),
  );
  ensureWorkspace(workspace.rootPath);
  await writeAgent(workspace.rootPath, "reviewer", {
    harness: "codex",
    instructions: "Review the work.",
  });

  // The peer handoff completes; the self-route is dropped with a note.
  const mixed = await toolCall(handler, token, 61, "Review time", [
    "reviewer",
    "default",
  ]);
  const mixedBody = (await mixed.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(mixedBody.result.isError).toBeUndefined();
  const mixedText = mixedBody.result.content[0]!.text;
  expect(mixedText).toContain("you are @default");
  expect(mixedText).toContain("naming yourself is ignored");
  expect(store.listMessages(thread.id).at(-1)!.metadata.routedTo).toEqual([
    "reviewer",
  ]);
  expect(routed).toHaveLength(1);

  // A to naming only the author routes nowhere and still sends, noted.
  const selfOnly = await toolCall(handler, token, 62, "I'll check later", [
    "default",
  ]);
  const selfBody = (await selfOnly.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(selfBody.result.isError).toBeUndefined();
  expect(selfBody.result.content[0]!.text).toContain("naming yourself is ignored");
  expect(store.listMessages(thread.id).at(-1)!.metadata.routedTo).toEqual([]);
  expect(routed).toHaveLength(1);
  store.close();
});

test("send_message warns when a mid-body peer mention routes nowhere", async () => {
  const routed: Array<{ message: Message; routedTo: string[] }> = [];
  const { store, thread, token, handler, workspace } = fixture(
    (message, routedTo) => routed.push({ message, routedTo }),
  );
  ensureWorkspace(workspace.rootPath);
  await writeAgent(workspace.rootPath, "reviewer", {
    harness: "codex",
    instructions: "Review the work.",
  });

  // The message sends — prose mentions are legal — but the result flags the
  // unrouted handle so an intended handoff is not lost silently.
  const response = await toolCall(
    handler,
    token,
    51,
    "Draft is done — @reviewer should take a look",
  );
  const body = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(body.result.isError).toBeUndefined();
  const text = body.result.content[0]!.text;
  expect(text).toContain("Message sent");
  expect(text).toContain("mentions @reviewer");
  expect(text).toContain('to: ["reviewer"]');
  expect(store.listMessages(thread.id).at(-1)!.content).toContain(
    "Draft is done",
  );
  expect(routed).toEqual([]);

  // A routed handoff gets no warning.
  const clean = await toolCall(handler, token, 52, "Now really over to you", [
    "reviewer",
  ]);
  const cleanBody = (await clean.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(cleanBody.result.content[0]!.text).not.toContain("Note:");
  store.close();
});

test("create_thread starts an agent-authored thread in the current channel", async () => {
  const routed: Array<{ message: Message; routedTo: string[] }> = [];
  const { store, thread, token, handler } = fixture((message, routedTo) =>
    routed.push({ message, routedTo }),
  );

  const response = await createThread(handler, token, 70, {
    content: "Tracking the release checklist here.",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(body.result.isError).toBeUndefined();
  const text = body.result.content[0]!.text;
  expect(text).toMatch(/^Thread created \(th_[^)]+\) in #general\.$/);

  const threadId = text.match(/\((th_[^)]+)\)/)![1]!;
  const created = store.getThread(threadId)!;
  expect(created.channelId).toBe(thread.channelId);
  const root = store.rootMessage(threadId)!;
  expect(root.author).toBe("agent");
  expect(root.content).toBe("Tracking the release checklist here.");
  expect(root.metadata).toEqual({
    agent: "default",
    mentions: [],
    routedTo: [],
  });
  // Nobody woken: no to list was given.
  expect(routed).toEqual([]);
  store.close();
});

test("create_thread routes an explicit to list in a named channel", async () => {
  const routed: Array<{ message: Message; routedTo: string[] }> = [];
  const { store, token, handler, workspace } = fixture((message, routedTo) =>
    routed.push({ message, routedTo }),
  );
  await writeAgent(workspace.rootPath, "reviewer", {
    harness: "codex",
    instructions: "Review the work.",
  });
  const other = store.createChannel(workspace.id, { name: "releases" });

  const response = await createThread(handler, token, 71, {
    content: "Release review thread",
    channel: "RELEASES",
    to: ["reviewer", "default"],
  });
  const body = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(body.result.isError).toBeUndefined();
  const text = body.result.content[0]!.text;
  expect(text).toContain("in #releases.");
  // The self-route is dropped with a note; the peer handoff sticks.
  expect(text).toContain("naming yourself is ignored");
  const threadId = text.match(/\((th_[^)]+)\)/)![1]!;
  expect(store.getThread(threadId)!.channelId).toBe(other.id);
  const root = store.rootMessage(threadId)!;
  expect(root.metadata.routedTo).toEqual(["reviewer"]);
  expect(routed).toEqual([{ message: root, routedTo: ["reviewer"] }]);

  const unknown = await createThread(handler, token, 72, {
    content: "Lost thread",
    channel: "missing",
  });
  const unknownBody = (await unknown.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(unknownBody.result.isError).toBe(true);
  expect(unknownBody.result.content[0]!.text).toContain(
    'Unknown channel "missing"',
  );
  store.close();
});

test("create_thread rejects a leading peer handle without to", async () => {
  const routed: Array<{ message: Message; routedTo: string[] }> = [];
  const { store, token, handler, workspace } = fixture((message, routedTo) =>
    routed.push({ message, routedTo }),
  );
  await writeAgent(workspace.rootPath, "reviewer", {
    harness: "codex",
    instructions: "Review the work.",
  });
  const channel = store.listChannels(workspace.id)[0]!;
  const before = store.listThreads(channel.id).length;

  const rejected = await createThread(handler, token, 80, {
    content: "@reviewer take a look at this",
  });
  const body = (await rejected.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0]!.text).toContain("EXPLICIT_RECIPIENT_REQUIRED");
  expect(store.listThreads(channel.id)).toHaveLength(before);
  expect(routed).toEqual([]);

  // A mid-body prose mention is legal but flagged: nobody was woken.
  const prose = await createThread(handler, token, 81, {
    content: "Parking this; @reviewer might weigh in later.",
  });
  const proseBody = (await prose.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(proseBody.result.isError).toBeUndefined();
  expect(proseBody.result.content[0]!.text).toContain(
    "no agent was woken in the new thread",
  );
  expect(routed).toEqual([]);
  store.close();
});

test("send_message rejects a leading peer handle without to", async () => {
  const routed: Array<{ message: Message; routedTo: string[] }> = [];
  const { store, thread, token, handler, workspace } = fixture(
    (message, routedTo) => routed.push({ message, routedTo }),
  );
  ensureWorkspace(workspace.rootPath);
  await writeAgent(workspace.rootPath, "reviewer", {
    harness: "codex",
    instructions: "Review the work.",
  });

  const before = store.listMessages(thread.id).length;
  const rejected = await toolCall(handler, token, 41, "@reviewer please look");
  const body = (await rejected.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0]!.text).toContain(
    "EXPLICIT_RECIPIENT_REQUIRED",
  );
  expect(body.result.content[0]!.text).toContain('to: ["reviewer"]');
  expect(store.listMessages(thread.id)).toHaveLength(before);
  expect(routed).toEqual([]);
  store.close();
});

test("read_thread reads any workspace thread", async () => {
  const { store, thread, token, tokens, handler } = fixture();
  const channel = store.listChannels(store.defaultWorkspace().id)[0]!;
  const attachment = attachFile(
    store,
    `att_${"a".repeat(32)}`,
    "spec.yaml",
    "text/yaml",
    "name: phi\n",
  );
  store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "Attached spec",
    metadata: { attachments: [attachment] },
  });
  const own = await callTool(handler, token, 50, "read_thread", {
    thread_id: thread.id,
  });
  const ownBody = (await own.json()) as {
    result: { content: Array<{ text: string }> };
  };
  const ownPayload = JSON.parse(ownBody.result.content[0]!.text) as {
    threadId: string;
    messages: Array<{ content: string; attachments?: unknown[] }>;
  };
  expect(ownPayload.threadId).toBe(thread.id);
  expect(ownPayload.messages[0]!.content).toBe("Start");
  expect(ownPayload.messages[1]!.attachments).toEqual([attachment]);

  const other = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "another topic",
  });
  const sibling = await callTool(handler, token, 51, "read_thread", {
    thread_id: other.thread.id,
  });
  const siblingBody = (await sibling.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(
    (JSON.parse(siblingBody.result.content[0]!.text) as {
      messages: Array<{ content: string }>;
    }).messages.map((message) => message.content),
  ).toEqual(["another topic"]);

  const comment = store.createDocComment(
    channel.id,
    { author: "user", kind: "message", content: "looks off" },
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      quote: "hello",
      prefix: "",
      suffix: "",
      headingSlug: null,
      parentThreadId: thread.id,
    },
  );
  const commentToken = tokens.mint({
    threadId: comment.thread.id,
    agentName: "default",
  });
  const parent = await callTool(handler, commentToken, 52, "read_thread", {
    thread_id: thread.id,
  });
  const parentBody = (await parent.json()) as {
    result: { content: Array<{ text: string }> };
  };
  const parentPayload = JSON.parse(parentBody.result.content[0]!.text) as {
    threadId: string;
  };
  expect(parentPayload.threadId).toBe(thread.id);
  store.close();
});

test("read_attachment returns bounded text from the current thread", async () => {
  const { store, thread, token, handler } = fixture();
  const attachment = attachFile(
    store,
    `att_${"b".repeat(32)}`,
    "spec.yaml",
    "application/yaml",
    "service:\n  port: 8080\n",
  );
  store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "Use this spec",
    metadata: { attachments: [attachment] },
  });

  const response = await callTool(handler, token, 53, "read_attachment", {
    attachment_id: attachment.id,
  });
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(JSON.parse(body.result.content[0]!.text)).toEqual({
    attachment,
    content: "service:\n  port: 8080\n",
    truncated: false,
  });
  store.close();
});

test("read_attachment accepts parameterized text-like MIME types", async () => {
  const { store, thread, token, handler } = fixture();
  const attachment = attachFile(
    store,
    `att_${"1".repeat(32)}`,
    "config.json",
    "application/json;charset=utf-8",
    '{"enabled":true}\n',
  );
  store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "JSON attachment",
    metadata: { attachments: [attachment] },
  });

  const response = await callTool(handler, token, 58, "read_attachment", {
    attachment_id: attachment.id,
  });
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(JSON.parse(body.result.content[0]!.text).content).toBe(
    '{"enabled":true}\n',
  );
  store.close();
});

test("read_attachment truncates text responses at the byte cap", async () => {
  const { store, thread, token, handler } = fixture();
  const attachment = attachFile(
    store,
    `att_${"f".repeat(32)}`,
    "large.txt",
    "text/plain",
    "x".repeat(256 * 1024 + 1),
  );
  store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "Large attachment",
    metadata: { attachments: [attachment] },
  });

  const response = await callTool(handler, token, 57, "read_attachment", {
    attachment_id: attachment.id,
  });
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }> };
  };
  const payload = JSON.parse(body.result.content[0]!.text) as {
    content: string;
    truncated: boolean;
  };
  expect(payload.content).toHaveLength(256 * 1024);
  expect(payload.truncated).toBe(true);
  store.close();
});

test("read_attachment reads cross-thread attachments and rejects binary files", async () => {
  const { store, thread, token, handler } = fixture();
  const channel = store.listChannels(store.defaultWorkspace().id)[0]!;
  const other = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Other thread",
  });
  const shared = attachFile(
    store,
    `att_${"c".repeat(32)}`,
    "notes.txt",
    "text/plain",
    "cross-thread notes",
  );
  store.appendMessage(other.thread.id, {
    author: "user",
    kind: "message",
    content: "Notes",
    metadata: { attachments: [shared] },
  });
  const crossThread = await callTool(handler, token, 54, "read_attachment", {
    attachment_id: shared.id,
  });
  const crossBody = (await crossThread.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(
    (JSON.parse(crossBody.result.content[0]!.text) as { content: string })
      .content,
  ).toBe("cross-thread notes");

  const malformed = await callTool(handler, token, 59, "read_attachment", {
    attachment_id: "../../secret",
  });
  const malformedBody = (await malformed.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(malformedBody.result.isError).toBe(true);
  expect(malformedBody.result.content[0]!.text).toContain(
    "not available in this workspace",
  );

  const image = attachFile(
    store,
    `att_${"d".repeat(32)}`,
    "image.png",
    "image/png",
    new Uint8Array([0, 1, 2, 3]),
  );
  store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "Image",
    metadata: { attachments: [image] },
  });
  const binary = await callTool(handler, token, 55, "read_attachment", {
    attachment_id: image.id,
  });
  const binaryBody = (await binary.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(binaryBody.result.isError).toBe(true);
  expect(binaryBody.result.content[0]!.text).toContain("not a supported text file");
  store.close();
});

test("read_attachment reports a referenced attachment whose file is missing", async () => {
  const { store, thread, token, handler } = fixture();
  const attachment = store.createAttachment({
    id: `att_${"2".repeat(32)}`,
    workspaceId: store.defaultWorkspace().id,
    filename: "missing.txt",
    contentType: "text/plain",
    byteSize: 10,
  });
  store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "Missing attachment",
    metadata: { attachments: [attachment] },
  });

  const response = await callTool(handler, token, 60, "read_attachment", {
    attachment_id: attachment.id,
  });
  const body = (await response.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0]!.text).toContain("file is unavailable");
  store.close();
});

test("read_attachment allows a doc comment to read its parent's attachment", async () => {
  const { store, thread, tokens, handler } = fixture();
  const channel = store.listChannels(store.defaultWorkspace().id)[0]!;
  const attachment = attachFile(
    store,
    `att_${"e".repeat(32)}`,
    "notes.txt",
    "text/plain",
    "parent context",
  );
  store.appendMessage(thread.id, {
    author: "user",
    kind: "message",
    content: "Parent attachment",
    metadata: { attachments: [attachment] },
  });
  const comment = store.createDocComment(
    channel.id,
    { author: "user", kind: "message", content: "Review this" },
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      quote: "hello",
      prefix: "",
      suffix: "",
      headingSlug: null,
      parentThreadId: thread.id,
    },
  );
  const commentToken = tokens.mint({
    threadId: comment.thread.id,
    agentName: "default",
  });
  const response = await callTool(
    handler,
    commentToken,
    56,
    "read_attachment",
    { attachment_id: attachment.id },
  );
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(JSON.parse(body.result.content[0]!.text).content).toBe("parent context");
  store.close();
});

test("send_message can post to a comment's parent thread only", async () => {
  const { store, thread, tokens, handler } = fixture();
  const channel = store.listChannels(store.defaultWorkspace().id)[0]!;
  const comment = store.createDocComment(
    channel.id,
    { author: "user", kind: "message", content: "looks off" },
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      quote: "hello",
      prefix: "",
      suffix: "",
      headingSlug: null,
      parentThreadId: thread.id,
    },
  );
  const commentToken = tokens.mint({
    threadId: comment.thread.id,
    agentName: "default",
  });
  const posted = await callTool(handler, commentToken, 60, "send_message", {
    content: "Resolved in the margin",
    thread_id: thread.id,
  });
  const postedBody = (await posted.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(postedBody.result.content[0]!.text).toContain("Message sent");
  expect(store.listMessages(thread.id).at(-1)?.content).toBe(
    "Resolved in the margin",
  );
  expect(store.listMessages(comment.thread.id)).toHaveLength(1);

  const other = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "elsewhere",
  });
  const rejected = await callTool(handler, commentToken, 61, "send_message", {
    content: "nope",
    thread_id: other.thread.id,
  });
  const rejectedBody = (await rejected.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(rejectedBody.result.isError).toBe(true);
  expect(store.listMessages(other.thread.id)).toHaveLength(1);
  store.close();
});
