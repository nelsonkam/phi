import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { messagingPreamble } from "@/core/agents/runtime";
import {
  routeAgentContent,
  unroutedPeerMentions,
} from "@/core/agents/routing";
import { HarnessCapabilityService } from "@/core/agents/capabilities";
import type { AgentHarnessCapabilityList } from "@/core/agents/capabilities";
import type { MessageSearchApi } from "@/core/search/message-search";
import type { PhiStore } from "@/core/store/store";
import type { McpTokenRegistry } from "@/server/mcp-token-registry";
import { attachmentsFromMetadata, resolveUploadFile } from "@/server/uploads";
import type { Attachment, Message } from "@/shared/types";

export const SEND_MESSAGE_DESCRIPTION = `Send a message in your current phi thread. This tool is your only voice: text you produce outside this tool is not shown. Hand off to peer agents only through the optional to list; message text never routes, and a message that leads with an @agent-handle without to is rejected so an intended handoff cannot silently reach no one. Reply first—either answer immediately or briefly name the first concrete step before doing other work. During multi-step work, send concise updates at meaningful beats without narrating routine mechanics. An acknowledgement does not deliver the result; send the actual answer or outcome through this tool before ending the turn. Close substantial work with a short recap. Each call creates one chat bubble, so prefer a short natural run of messages over one long report; for durable or reviewable material, a doc under the channel plus a linked summary beats a long report in chat. Structure (bullets, headers) is earned by enumerable content, never the default. Omit thread_id to stay in the current thread. On a doc-comment turn, do not post a follow-up or recap into the parent; set thread_id to the comment's parent only if the user asked you to post in the sharing conversation, or a decision must be recorded there. Other thread ids are rejected.`;
export const SEARCH_MESSAGES_DESCRIPTION = `Search messages across other threads in your phi workspace using exact phrase/keyword matching and semantic similarity. Use this to recover prior decisions, requirements, identifiers, and related discussions. The workspace and current thread come from your session; do not ask the user for a thread or channel ID. You may optionally include the current thread, narrow results using a channel name, or filter by author.`;
export const READ_THREAD_DESCRIPTION = `Read messages in a thread by id. Use this to pull a parent conversation linked from a doc-comment turn. The id must be your current thread or, when this turn is a comment, that comment's parent thread.`;
export const READ_ATTACHMENT_DESCRIPTION = `Read a text attachment referenced by a message in your current thread or, for a doc-comment turn, its parent thread. Use the attachment id shown in the prompt or returned by read_thread. Binary attachments are not readable through this tool, and large text files are truncated to a bounded response.`;
export const LIST_AGENT_HARNESSES_DESCRIPTION = `List agent harnesses available on this machine and the exact model and config values they accept. Model IDs and config values are copied verbatim from ACP and can be used directly in phi agent files or anonymous-agent dispatch arguments. Omit harness to inspect every known harness, including unavailable ones; pass a harness ID to inspect only that harness.`;
export const CREATE_CHANNEL_DESCRIPTION = `Create a channel in your current phi workspace. A channel can attach existing folders outside phi's managed workspace; those folders become writable workspace roots for agent sessions in the channel. Folder paths must be absolute directories. Names use lowercase letters, numbers, and hyphens.`;
export const CREATE_THREAD_DESCRIPTION = `Start a new thread in a channel of your phi workspace, authored by you. Use it to spin a separate topic out of the current conversation or to file work in the channel it belongs to; you stay in your current thread and the new thread runs independently. Untagged user replies in the new thread come back to you, so omit \`to\` when the thread is yours to own. The optional \`to\` list hands the new thread's first turn to peer agents, exactly like send_message: message text never routes, and a leading @handle without \`to\` is rejected. The channel defaults to your current thread's channel.`;

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
      { capabilities: { tools: {} }, instructions: messagingPreamble(caller.agentName) },
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
              thread_id: {
                type: "string",
                minLength: 1,
                description:
                  "Omit to reply in the current thread. On a doc-comment turn, do not use this for a follow-up recap; set it to the parent only if the user asked to post in the sharing conversation, or a decision must be recorded there.",
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
        {
          name: "create_thread",
          description: CREATE_THREAD_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              content: {
                type: "string",
                minLength: 1,
                description: "Markdown root message of the new thread",
              },
              channel: {
                type: "string",
                minLength: 1,
                description:
                  "Channel name to create the thread in; defaults to your current channel",
              },
              to: {
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: { type: "string", minLength: 1 },
                description:
                  "Agent handles to wake in the new thread, in turn order; the only way the root message routes",
              },
            },
            required: ["content"],
            additionalProperties: false,
          },
        },
        {
          name: "read_thread",
          description: READ_THREAD_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              thread_id: {
                type: "string",
                minLength: 1,
                description:
                  "Thread to read; must be the current thread or this comment's parent",
              },
            },
            required: ["thread_id"],
            additionalProperties: false,
          },
        },
        {
          name: "read_attachment",
          description: READ_ATTACHMENT_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              attachment_id: {
                type: "string",
                pattern: "^att_[a-f0-9]{32}$",
                description: "Server-owned attachment id",
              },
            },
            required: ["attachment_id"],
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
                    includeCurrentThread: {
                      type: "boolean",
                      description:
                        "Include matches from your current thread (default false)",
                    },
                    author: {
                      type: "string",
                      enum: ["user", "agent"],
                      description: "Optional message author filter",
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
      if (request.params.name === "create_thread") {
        const thread = store.getThread(caller.threadId);
        if (!thread) {
          return toolError("Current thread no longer exists");
        }
        const rawContent = request.params.arguments?.content;
        const content = typeof rawContent === "string" ? rawContent.trim() : "";
        if (content.length === 0) {
          return toolError("content is required");
        }
        const rawChannel = request.params.arguments?.channel;
        if (rawChannel !== undefined && typeof rawChannel !== "string") {
          return toolError("channel must be a string");
        }
        const channelName =
          typeof rawChannel === "string" ? rawChannel.trim() : undefined;
        if (rawChannel !== undefined && !channelName) {
          return toolError("channel must not be empty");
        }
        const rawTo = request.params.arguments?.to;
        if (
          rawTo !== undefined &&
          (!Array.isArray(rawTo) ||
            rawTo.length === 0 ||
            rawTo.some((name) => typeof name !== "string" || !name.trim()))
        ) {
          return toolError("to must be a non-empty list of agent names");
        }
        const explicitRecipients = Array.isArray(rawTo)
          ? rawTo.map((name) => String(name).trim())
          : undefined;
        const channel = channelName
          ? store
              .listChannels(thread.workspaceId)
              .find(
                (candidate) =>
                  candidate.name.toLocaleLowerCase() ===
                  channelName.toLocaleLowerCase(),
              )
          : store.getChannel(thread.channelId);
        if (!channel) {
          return toolError(
            channelName
              ? `Unknown channel "${channelName}"`
              : "Current channel no longer exists",
          );
        }
        return tokens.runOnce(
          token,
          `create_thread:${JSON.stringify({
            channel: channel.id,
            content,
            to: explicitRecipients,
          })}`,
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
              return toolError((error as Error).message);
            }
            const created = store.createThread(channel.id, {
              author: "agent",
              kind: "message",
              content,
              metadata: { agent: caller.agentName, ...routing },
            });
            if (routing.routedTo.length > 0) {
              onAgentMessage?.(created.message, routing.routedTo);
            }
            const notes: string[] = [];
            // The root is the caller's own agent message, so untagged replies
            // already fall back to the caller; a self-route adds nothing.
            if (explicitRecipients?.includes(caller.agentName)) {
              notes.push(
                ` Note: you are @${caller.agentName} — a \`to\` naming yourself is ignored; untagged replies in the new thread already come to you.`,
              );
            }
            if (routing.routedTo.length === 0) {
              const unrouted = await unroutedPeerMentions(
                store.defaultWorkspace().rootPath,
                content,
                caller.agentName,
              );
              if (unrouted.length > 0) {
                notes.push(
                  ` Note: it mentions ${unrouted
                    .map((handle) => `@${handle}`)
                    .join(
                      ", ",
                    )} but has no \`to\`, so no agent was woken in the new thread — mentions never route.`,
                );
              }
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Thread created (${created.thread.id}) in #${channel.name}.${notes.join("")}`,
                },
              ],
            };
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
        const rawIncludeCurrentThread =
          request.params.arguments?.includeCurrentThread;
        const rawAuthor = request.params.arguments?.author;
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
        if (
          rawIncludeCurrentThread !== undefined &&
          typeof rawIncludeCurrentThread !== "boolean"
        ) {
          return toolError("includeCurrentThread must be a boolean");
        }
        if (
          rawAuthor !== undefined &&
          rawAuthor !== "user" &&
          rawAuthor !== "agent"
        ) {
          return toolError('author must be "user" or "agent"');
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
          `search_messages:${JSON.stringify({ query, channel, rawLimit, rawIncludeCurrentThread, rawAuthor })}`,
          extra.requestId,
          async () => {
            const result = await messageSearch.search(
              thread.workspaceId,
              {
                query,
                ...(channel ? { channel } : {}),
                ...(typeof rawLimit === "number" ? { limit: rawLimit } : {}),
                ...(typeof rawIncludeCurrentThread === "boolean"
                  ? { includeCurrentThread: rawIncludeCurrentThread }
                  : {}),
                ...(rawAuthor === "user" || rawAuthor === "agent"
                  ? { author: rawAuthor }
                  : {}),
              },
              { currentThreadId: caller.threadId },
            );
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
      if (request.params.name === "read_thread") {
        const rawId = request.params.arguments?.thread_id;
        const requested =
          typeof rawId === "string" ? rawId.trim() : "";
        if (!requested) {
          return toolError("thread_id is required");
        }
        const allowed = allowedReadThreadId(store, caller.threadId, requested);
        if (!allowed.ok) return toolError(allowed.error);
        return tokens.runOnce(
          token,
          `read_thread:${requested}`,
          extra.requestId,
          async () => {
            const messages = store.listMessages(requested);
            const truncated = messages.length > READ_THREAD_MAX;
            const slice = truncated
              ? messages.slice(-READ_THREAD_MAX)
              : messages;
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    threadId: requested,
                    truncated,
                    messages: slice.map(serializeReadMessage),
                  }),
                },
              ],
            };
          },
        );
      }
      if (request.params.name === "read_attachment") {
        const rawId = request.params.arguments?.attachment_id;
        const attachmentId = typeof rawId === "string" ? rawId.trim() : "";
        if (!attachmentId) return toolError("attachment_id is required");
        const attachment = allowedAttachment(
          store,
          caller.threadId,
          attachmentId,
        );
        if (!attachment) {
          return toolError("attachment is not available in this thread");
        }
        if (!isTextAttachment(attachment)) {
          return toolError("attachment is not a supported text file");
        }
        return tokens.runOnce(
          token,
          `read_attachment:${attachmentId}`,
          extra.requestId,
          async () => {
            const filePath = resolveUploadFile(store.rootPath, attachmentId);
            if (!filePath) return toolError("attachment file is unavailable");
            const bytes = await Bun.file(filePath)
              .slice(0, READ_ATTACHMENT_MAX_BYTES + 1)
              .bytes();
            const truncated = bytes.byteLength > READ_ATTACHMENT_MAX_BYTES;
            const body = truncated
              ? bytes.subarray(0, READ_ATTACHMENT_MAX_BYTES)
              : bytes;
            let content: string;
            try {
              content = new TextDecoder("utf-8", { fatal: true }).decode(body, {
                stream: truncated,
              });
            } catch {
              return toolError("attachment is not valid UTF-8 text");
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ attachment, content, truncated }),
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
      const rawThreadId = request.params.arguments?.thread_id;
      if (
        rawThreadId !== undefined &&
        (typeof rawThreadId !== "string" || !rawThreadId.trim())
      ) {
        return toolError("thread_id must be a non-empty string");
      }
      const requestedThreadId =
        typeof rawThreadId === "string" ? rawThreadId.trim() : undefined;
      const destination = resolveSendThreadId(
        store,
        caller.threadId,
        requestedThreadId,
      );
      if (!destination.ok) return toolError(destination.error);
      return tokens.runOnce(
        token,
        `send_message:${JSON.stringify({ content, to: explicitRecipients, thread_id: destination.threadId })}`,
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
          const message = store.appendMessage(destination.threadId, {
            author: "agent",
            kind: "message",
            content,
            metadata: { agent: caller.agentName, ...routing },
          });
          tokens.recordSend(token);
          if (routing.routedTo.length > 0) {
            onAgentMessage?.(message, routing.routedTo);
          }
          const notes: string[] = [];
          // A self-route is dropped by design (an agent cannot schedule its
          // own next turn); say so while the author's turn is still live and
          // it can do that work itself.
          if (explicitRecipients?.includes(caller.agentName)) {
            notes.push(
              ` Note: you are @${caller.agentName} — a \`to\` naming yourself is ignored and cannot schedule your own turn. Do that work now, before ending this turn, or hand it to a peer.`,
            );
          }
          // A prose handoff ("done — @reviewer should look") wakes nobody;
          // warn while the author still has a turn to send a routed follow-up.
          if (routing.routedTo.length === 0) {
            const unrouted = await unroutedPeerMentions(
              store.defaultWorkspace().rootPath,
              content,
              caller.agentName,
            );
            if (unrouted.length > 0) {
              notes.push(
                ` Note: it mentions ${unrouted
                  .map((handle) => `@${handle}`)
                  .join(
                    ", ",
                  )} but has no \`to\`, so no agent was woken — mentions never route. If a handoff was intended, follow up with to: [${unrouted
                  .map((handle) => `"${handle}"`)
                  .join(", ")}].`,
              );
            }
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Message sent (${message.id}).${notes.join("")}`,
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

const READ_THREAD_MAX = 50;
const READ_ATTACHMENT_MAX_BYTES = 256 * 1024;

function allowedReadThreadId(
  store: PhiStore,
  callerThreadId: string,
  requested: string,
): { ok: true } | { ok: false; error: string } {
  if (requested === callerThreadId) return { ok: true };
  const caller = store.getThread(callerThreadId);
  const parent =
    caller?.kind === "doc_comment"
      ? store.getDocCommentAnchor(callerThreadId)?.parentThreadId
      : null;
  if (parent && requested === parent) return { ok: true };
  return {
    ok: false,
    error:
      "thread_id must be the current thread or this comment's parent thread",
  };
}

function resolveSendThreadId(
  store: PhiStore,
  callerThreadId: string,
  requested: string | undefined,
): { ok: true; threadId: string } | { ok: false; error: string } {
  if (!requested || requested === callerThreadId) {
    return { ok: true, threadId: callerThreadId };
  }
  const caller = store.getThread(callerThreadId);
  const parent =
    caller?.kind === "doc_comment"
      ? store.getDocCommentAnchor(callerThreadId)?.parentThreadId
      : null;
  if (parent && requested === parent) {
    return { ok: true, threadId: requested };
  }
  return {
    ok: false,
    error:
      "thread_id must be the current thread or this comment's parent thread",
  };
}

function serializeReadMessage(message: Message) {
  const attachments = attachmentsFromMetadata(message.metadata);
  return {
    id: message.id,
    author: message.author,
    content: message.content,
    createdAt: message.createdAt,
    ...(typeof message.metadata.agent === "string"
      ? { agent: message.metadata.agent }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function allowedAttachment(
  store: PhiStore,
  callerThreadId: string,
  attachmentId: string,
): Attachment | null {
  const threadIds = [callerThreadId];
  const caller = store.getThread(callerThreadId);
  const parent =
    caller?.kind === "doc_comment"
      ? store.getDocCommentAnchor(callerThreadId)?.parentThreadId
      : null;
  if (parent) threadIds.push(parent);
  const referenced = threadIds.some((threadId) =>
    store
      .listMessages(threadId)
      .some((message) =>
        attachmentsFromMetadata(message.metadata).some(
          (attachment) => attachment.id === attachmentId,
        ),
      ),
  );
  return referenced ? store.getAttachment(attachmentId) : null;
}

function isTextAttachment(attachment: Attachment): boolean {
  const type = attachment.contentType.split(";")[0]!.trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === "application/yaml" ||
    type === "application/x-yaml" ||
    type === "application/toml"
  );
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
