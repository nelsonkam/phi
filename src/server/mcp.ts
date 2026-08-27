import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { MESSAGING_PREAMBLE } from "@/core/agents/runtime";
import {
  routeAgentContent,
  unroutedPeerMentions,
} from "@/core/agents/routing";
import { HarnessCapabilityService } from "@/core/agents/capabilities";
import type { AgentHarnessCapabilityList } from "@/core/agents/capabilities";
import type { MessageSearchApi } from "@/core/search/message-search";
import type { PhiStore } from "@/core/store/store";
import type { McpTokenRegistry } from "@/server/mcp-token-registry";
import type { Message } from "@/shared/types";

export const SEND_MESSAGE_DESCRIPTION = `Send a message in your current phi thread. This tool is your only voice: text you produce outside this tool is not shown. Hand off to peer agents only through the optional to list; message text never routes, and a message that leads with an @agent-handle without to is rejected so an intended handoff cannot silently reach no one. Reply first—either answer immediately or briefly name the first concrete step before doing other work. During multi-step work, send concise updates at meaningful beats without narrating routine mechanics. An acknowledgement does not deliver the result; send the actual answer or outcome through this tool before ending the turn. Close substantial work with a short recap. Each call creates one chat bubble, so prefer a short natural run of messages over one long report.`;
export const SEARCH_MESSAGES_DESCRIPTION = `Search messages across your phi workspace using both exact keyword matching and semantic similarity. Use this to recover prior decisions, requirements, identifiers, and related discussions. The workspace comes from your session; do not ask the user for a thread or channel ID. You may optionally narrow results using a channel name.`;
export const LIST_AGENT_HARNESSES_DESCRIPTION = `List agent harnesses available on this machine and the exact model and config values they accept. Model IDs and config values are copied verbatim from ACP and can be used directly in phi agent files or anonymous-agent dispatch arguments. Omit harness to inspect every known harness, including unavailable ones; pass a harness ID to inspect only that harness.`;
export const CREATE_CHANNEL_DESCRIPTION = `Create a channel in your current phi workspace. A channel can attach existing folders outside phi's managed workspace; those folders become writable workspace roots for agent sessions in the channel. Folder paths must be absolute directories. Names use lowercase letters, numbers, and hyphens.`;

export interface AgentHarnessCapabilityApi {
  list(harnessId?: string): Promise<AgentHarnessCapabilityList>;
}

export function createMcpHandler(
  store: PhiStore,
  tokens: McpTokenRegistry,
  messageSearch?: MessageSearchApi,
  onAgentMessage?: (message: Message, routedTo: string[]) => void,
  harnessCapabilities: AgentHarnessCapabilityApi = new HarnessCapabilityService(
    store.defaultWorkspace().rootPath,
  ),
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
              to: {
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: { type: "string", minLength: 1 },
                description:
                  "Agent handles to hand the turn to, in turn order; the only way an agent message routes",
              },
            },
            required: ["content"],
            additionalProperties: false,
          },
        },
        {
          name: "list_agent_harnesses",
          description: LIST_AGENT_HARNESSES_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              harness: {
                type: "string",
                minLength: 1,
                description:
                  "Optional harness ID; omit to list every known harness",
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: "create_channel",
          description: CREATE_CHANNEL_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                minLength: 1,
                maxLength: 63,
                pattern: "^[a-z0-9][a-z0-9-]*$",
                description: "Lowercase channel name",
              },
              purpose: {
                type: "string",
                minLength: 1,
                description: "Optional channel purpose",
              },
              folders: {
                type: "array",
                uniqueItems: true,
                items: { type: "string", minLength: 1 },
                description:
                  "Existing absolute folders outside phi's managed workspace",
              },
            },
            required: ["name"],
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
      if (request.params.name === "create_channel") {
        const thread = store.getThread(caller.threadId);
        if (!thread) {
          return toolError("Current thread no longer exists");
        }
        const rawName = request.params.arguments?.name;
        const name = typeof rawName === "string" ? rawName.trim() : "";
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
          return toolError(
            "name must be 1-63 lowercase letters, numbers, or hyphens, starting with a letter or number",
          );
        }
        const rawPurpose = request.params.arguments?.purpose;
        if (rawPurpose !== undefined && typeof rawPurpose !== "string") {
          return toolError("purpose must be a string");
        }
        const purpose =
          typeof rawPurpose === "string" ? rawPurpose.trim() : undefined;
        if (rawPurpose !== undefined && !purpose) {
          return toolError("purpose must not be empty");
        }
        const rawFolders = request.params.arguments?.folders;
        if (
          rawFolders !== undefined &&
          (!Array.isArray(rawFolders) ||
            rawFolders.some(
              (folder) => typeof folder !== "string" || !folder.trim(),
            ))
        ) {
          return toolError("folders must be a list of non-empty paths");
        }
        let folders: string[];
        try {
          folders = canonicalExternalFolders(
            Array.isArray(rawFolders) ? rawFolders.map(String) : [],
            store.defaultWorkspace().rootPath,
          );
        } catch (error) {
          return toolError((error as Error).message);
        }
        return tokens.runOnce(
          token,
          `create_channel:${JSON.stringify({ name, purpose, folders })}`,
          extra.requestId,
          async () => {
            try {
              const channel = store.createChannel(thread.workspaceId, {
                name,
                purpose,
                folders,
              });
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ channel }),
                  },
                ],
              };
            } catch (error) {
              const message = (error as Error).message;
              return toolError(
                message.includes("UNIQUE constraint failed")
                  ? `A channel named "${name}" already exists`
                  : message,
              );
            }
          },
        );
      }
      if (request.params.name === "list_agent_harnesses") {
        const rawHarness = request.params.arguments?.harness;
        if (rawHarness !== undefined && typeof rawHarness !== "string") {
          return {
            isError: true,
            content: [{ type: "text", text: "harness must be a string" }],
          };
        }
        const harness =
          typeof rawHarness === "string" ? rawHarness.trim() : undefined;
        if (rawHarness !== undefined && !harness) {
          return {
            isError: true,
            content: [{ type: "text", text: "harness is required" }],
          };
        }
        return tokens.runOnce(
          token,
          `list_agent_harnesses:${harness ?? "*"}`,
          extra.requestId,
          async () => {
            try {
              const result = await harnessCapabilities.list(harness);
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(result) },
                ],
              };
            } catch (error) {
              return {
                isError: true,
                content: [
                  { type: "text" as const, text: (error as Error).message },
                ],
              };
            }
          },
        );
      }
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
      const rawTo = request.params.arguments?.to;
      if (
        rawTo !== undefined &&
        (!Array.isArray(rawTo) ||
          rawTo.length === 0 ||
          rawTo.some((name) => typeof name !== "string" || !name.trim()))
      ) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "to must be a non-empty list of agent names",
            },
          ],
        };
      }
      const explicitRecipients = Array.isArray(rawTo)
        ? rawTo.map((name) => String(name).trim())
        : undefined;
      return tokens.runOnce(
        token,
        `send_message:${JSON.stringify({ content, to: explicitRecipients })}`,
        extra.requestId,
        async () => {
          let routing: Awaited<ReturnType<typeof routeAgentContent>>;
          try {
            routing = await routeAgentContent(
              store.defaultWorkspace().rootPath,
              content,
              caller.agentName,
              explicitRecipients,
              { requireExplicitHandoff: true },
            );
          } catch (error) {
            return {
              isError: true,
              content: [
                { type: "text" as const, text: (error as Error).message },
              ],
            };
          }
          const message = store.appendMessage(caller.threadId, {
            author: "agent",
            kind: "message",
            content,
            metadata: { agent: caller.agentName, ...routing },
          });
          tokens.recordSend(token);
          if (routing.routedTo.length > 0) {
            onAgentMessage?.(message, routing.routedTo);
          }
          // A prose handoff ("done — @reviewer should look") wakes nobody;
          // warn while the author still has a turn to send a routed follow-up.
          let note = "";
          if (routing.routedTo.length === 0) {
            const unrouted = await unroutedPeerMentions(
              store.defaultWorkspace().rootPath,
              content,
              caller.agentName,
            );
            if (unrouted.length > 0) {
              note = ` Note: it mentions ${unrouted
                .map((handle) => `@${handle}`)
                .join(
                  ", ",
                )} but has no \`to\`, so no agent was woken — mentions never route. If a handoff was intended, follow up with to: [${unrouted
                .map((handle) => `"${handle}"`)
                .join(", ")}].`;
            }
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Message sent (${message.id}).${note}`,
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

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function canonicalExternalFolders(
  folders: string[],
  workspaceRoot: string,
): string[] {
  const root = realpathSync(workspaceRoot);
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const rawFolder of folders) {
    const folder = rawFolder.trim();
    if (!isAbsolute(folder)) {
      throw new Error(`folder must be absolute: ${folder}`);
    }
    let resolved: string;
    try {
      resolved = realpathSync(folder);
      if (!statSync(resolved).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new Error(`folder does not exist or is not a directory: ${folder}`);
    }
    const fromRoot = relative(root, resolved);
    if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) {
      throw new Error(`folder must be outside phi's workspace: ${folder}`);
    }
    if (!seen.has(resolved)) {
      seen.add(resolved);
      canonical.push(resolved);
    }
  }
  return canonical;
}
