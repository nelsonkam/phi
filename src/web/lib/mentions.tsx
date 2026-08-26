import { useMemo } from "react";
import { FileLink } from "@/web/components/file-link";
import { TEXT_PATH_PATTERN } from "@/web/lib/file-links";
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

// Renders plain (verbatim) message text with its inline references decorated:
// valid @mentions become accent pills, workspace-looking paths become file
// chips. Everything unrecognized stays exactly as typed.
export function renderRichText(
  text: string,
  known: ReadonlySet<string>,
): React.ReactNode {
  const nodes = splitMentions(text, known).flatMap((node) =>
    typeof node === "string" ? linkifyPaths(node) : [node],
  );
  if (nodes.length === 1 && typeof nodes[0] === "string") return nodes[0];
  return nodes;
}

function splitMentions(
  text: string,
  known: ReadonlySet<string>,
): React.ReactNode[] {
  if (known.size === 0 || !text.includes("@")) return [text];
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const index = match.index;
    // Tokens trailing a word character (e-mail local parts) or naming no
    // known agent stay plain text.
    if (index > 0 && /[\w@]/.test(text[index - 1]!)) continue;
    if (!known.has(match[1]!.toLowerCase())) continue;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    nodes.push(
      <span key={`m${index}`} className="mention">
        {match[0]}
      </span>,
    );
    cursor = index + match[0].length;
  }
  if (nodes.length === 0) return [text];
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function linkifyPaths(text: string): React.ReactNode[] {
  if (!text.includes("/")) return [text];
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TEXT_PATH_PATTERN)) {
    const index = match.index;
    // Skip matches embedded in a longer token (URLs, absolute paths).
    if (index > 0 && /[\w/@.:%+=-]/.test(text[index - 1]!)) continue;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    nodes.push(
      <FileLink key={`f${index}`} path={match[0].replace(/^\.\//, "")} />,
    );
    cursor = index + match[0].length;
  }
  if (nodes.length === 0) return [text];
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
