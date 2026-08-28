import type { Agent, Message } from "@/shared/types";

// Who gets a reply that does not lead with @name: the last agent that
// answered in the thread, else the agent the root message routed to, else
// the workspace default. Mirrors threadFallbackAgent + routeUserContent on
// the server, including the degrade-to-default for a since-deleted agent.
export function threadUntaggedAgent(
  messages: readonly Pick<Message, "author" | "metadata">[] | null | undefined,
  agents: readonly Agent[] | undefined,
): string | null {
  const known = new Set((agents ?? []).map((agent) => agent.name));
  const workspaceDefault =
    agents?.find((agent) => agent.role === "default")?.name ?? null;
  const last = messages?.findLast(
    (message) =>
      message.author === "agent" && typeof message.metadata.agent === "string",
  );
  if (last) {
    const name = last.metadata.agent as string;
    return known.has(name) ? name : workspaceDefault;
  }
  // Only the primary recipient counts, exactly like the server's
  // threadFallbackAgent: a deleted routed[0] degrades to the workspace
  // default even when a speculative recipient later in the list survives.
  const routed = messages?.[0]?.metadata.routedTo;
  const primary = Array.isArray(routed) ? routed[0] : undefined;
  if (typeof primary === "string" && primary.length > 0 && known.has(primary)) {
    return primary;
  }
  return workspaceDefault;
}
