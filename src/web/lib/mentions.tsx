import { useMemo } from "react";
import { useAgents } from "@/web/lib/queries";

// Matches the agent-name grammar used by routing (see core/agents/routing.ts).
const MENTION_PATTERN = /@([a-z0-9][a-z0-9-]*)/gi;

// The loaded agent registry as a lowercase name set, for validating which
// @tokens are real mentions. Empty until the agents query resolves, so
// highlighting degrades to plain text rather than guessing.
export function useKnownAgentNames(): ReadonlySet<string> {
  const { data } = useAgents();
  return useMemo(
    () => new Set((data?.agents ?? []).map((agent) => agent.name)),
    [data],
  );
}

// Renders plain text with every valid @mention wrapped in a Slack-style
// accent pill. Tokens that trail a word character (e-mail local parts) or
// name no known agent stay plain text.
export function renderMentions(
  text: string,
  known: ReadonlySet<string>,
): React.ReactNode {
  if (known.size === 0 || !text.includes("@")) return text;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const index = match.index;
    if (index > 0 && /[\w@]/.test(text[index - 1]!)) continue;
    if (!known.has(match[1]!.toLowerCase())) continue;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    nodes.push(
      <span key={index} className="mention">
        {match[0]}
      </span>,
    );
    cursor = index + match[0].length;
  }
  if (nodes.length === 0) return text;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
