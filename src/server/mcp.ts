import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MESSAGING_PREAMBLE } from "@/core/agents/runtime";
import type { PhiStore } from "@/core/store/store";
import type { McpTokenRegistry } from "@/server/mcp-token-registry";

export const SEND_MESSAGE_DESCRIPTION = `Send a message to the user in your current phi thread. This tool is your only voice: text you produce outside this tool is not shown to the user. Reply first—either answer immediately or briefly name the first concrete step before doing other work. During multi-step work, send concise updates at meaningful beats without narrating routine mechanics. An acknowledgement does not deliver the result; send the actual answer or outcome through this tool before ending the turn. Close substantial work with a short recap. Each call creates one chat bubble, so prefer a short natural run of messages over one long report.`;

export function createMcpHandler(
  store: PhiStore,
  tokens: McpTokenRegistry,
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
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
