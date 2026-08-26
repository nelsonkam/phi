import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MESSAGING_PREAMBLE } from "@/core/agents/runtime";
import type { MessageSearchApi } from "@/core/search/message-search";
import type { PhiStore } from "@/core/store/store";
import type { McpTokenRegistry } from "@/server/mcp-token-registry";

export const SEND_MESSAGE_DESCRIPTION = `Send a message to the user in your current phi thread. This tool is your only voice: text you produce outside this tool is not shown to the user. Reply first—either answer immediately or briefly name the first concrete step before doing other work. During multi-step work, send concise updates at meaningful beats without narrating routine mechanics. An acknowledgement does not deliver the result; send the actual answer or outcome through this tool before ending the turn. Close substantial work with a short recap. Each call creates one chat bubble, so prefer a short natural run of messages over one long report.`;
export const SEARCH_MESSAGES_DESCRIPTION = `Search messages across your phi workspace using both exact keyword matching and semantic similarity. Use this to recover prior decisions, requirements, identifiers, and related discussions. The workspace comes from your session; do not ask the user for a thread or channel ID. You may optionally narrow results using a channel name.`;

export function createMcpHandler(
  store: PhiStore,
  tokens: McpTokenRegistry,
  messageSearch?: MessageSearchApi,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const token = bearerToken(req.headers.get("authorization"));
    const caller = token ? tokens.lookup(token) : null;
    if (!token || !caller) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        },
        { status: 401 },
      );
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // `instructions` lands in the system prompt on harnesses that honor it;
    // the first-turn prompt preamble in AgentRuntime covers the rest.
    const server = new Server(
      { name: "phi", version: "1.0.0" },
      { capabilities: { tools: {} }, instructions: MESSAGING_PREAMBLE },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "send_message",
          description: SEND_MESSAGE_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              content: {
                type: "string",
                minLength: 1,
                description: "Markdown message to send",
              },
            },
            required: ["content"],
            additionalProperties: false,
          },
        },
        ...(messageSearch
          ? [
              {
                name: "search_messages",
                description: SEARCH_MESSAGES_DESCRIPTION,
                inputSchema: {
                  type: "object" as const,
                  properties: {
                    query: {
                      type: "string",
                      minLength: 1,
                      description: "What to find in workspace messages",
                    },
                    channel: {
                      type: "string",
                      minLength: 1,
                      description: "Optional channel name to search within",
                    },
                    limit: {
                      type: "integer",
                      minimum: 1,
                      maximum: 20,
                      description: "Maximum results to return (default 8)",
                    },
                  },
                  required: ["query"],
                  additionalProperties: false,
                },
              },
            ]
          : []),
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (request.params.name === "search_messages" && messageSearch) {
        const rawQuery = request.params.arguments?.query;
        const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
        const rawChannel = request.params.arguments?.channel;
        const channel =
          typeof rawChannel === "string" ? rawChannel.trim() : undefined;
        const rawLimit = request.params.arguments?.limit;
        if (!query) {
          return {
            isError: true,
            content: [{ type: "text", text: "query is required" }],
          };
        }
        if (
          rawLimit !== undefined &&
          (!Number.isInteger(rawLimit) ||
            Number(rawLimit) < 1 ||
            Number(rawLimit) > 20)
        ) {
          return {
            isError: true,
            content: [
              { type: "text", text: "limit must be an integer from 1 to 20" },
            ],
          };
        }
        const thread = store.getThread(caller.threadId);
        if (!thread) {
          return {
            isError: true,
            content: [
              { type: "text", text: "Current thread no longer exists" },
            ],
          };
        }
        if (
          channel &&
          !store
            .listChannels(thread.workspaceId)
            .some(
              (candidate) =>
                candidate.name.toLocaleLowerCase() ===
                channel.toLocaleLowerCase(),
            )
        ) {
          return {
            isError: true,
            content: [{ type: "text", text: `Unknown channel "${channel}"` }],
          };
        }
        return tokens.runOnce(
          token,
          `search_messages:${JSON.stringify({ query, channel, rawLimit })}`,
          extra.requestId,
          async () => {
            const result = await messageSearch.search(thread.workspaceId, {
              query,
              ...(channel ? { channel } : {}),
              ...(typeof rawLimit === "number" ? { limit: rawLimit } : {}),
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(result),
                },
              ],
            };
          },
        );
      }
      if (request.params.name !== "send_message") {
        return {
          isError: true,
          content: [{ type: "text", text: "Unknown tool" }],
        };
      }
      const rawContent = request.params.arguments?.content;
      const content = typeof rawContent === "string" ? rawContent.trim() : "";
      if (content.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "content is required" }],
        };
      }

      return tokens.runOnce(
        token,
        `send_message:${content}`,
        extra.requestId,
        () => {
          const message = store.appendMessage(caller.threadId, {
            author: "coordinator",
            kind: "message",
            content,
            metadata: { agent: caller.agentName },
          });
          tokens.recordSend(token);
          return {
            content: [
              {
                type: "text" as const,
                text: `Message sent (${message.id}).`,
              },
            ],
          };
        },
      );
    });

    try {
      await server.connect(transport);
      return await transport.handleRequest(req);
    } catch (error) {
      console.error("MCP request failed", error);
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        },
        { status: 500 },
      );
    } finally {
      await server.close().catch(() => {});
    }
  };
}

function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}
