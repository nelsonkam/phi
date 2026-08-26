import type { Agent, Message } from "@/shared/types";

// Who gets a reply that does not lead with @name: the agent the root
// message routed to, else the workspace default.
export function threadUntaggedAgent(
  root: Pick<Message, "metadata"> | null | undefined,
  agents: readonly Agent[] | undefined,
): string | null {
  const known = new Set((agents ?? []).map((agent) => agent.name));
  const routed = root?.metadata.routedTo;
  if (Array.isArray(routed)) {
    const name = routed.find(
      (item): item is string =>
        typeof item === "string" && item.length > 0 && known.has(item),
    );
    if (name) return name;
  }
  return agents?.find((agent) => agent.role === "default")?.name ?? null;
}
