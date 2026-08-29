import { useMemo } from "react";
import { FileLink } from "@/web/components/file-link";
import { TEXT_PATH_PATTERN, parseWorkspaceHref } from "@/web/lib/file-links";
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
  if (!text.includes("/") && !text.includes("](")) return [text];
  type Hit = {
    index: number;
    end: number;
    path: string;
    fragment?: string;
    label?: string;
  };
  const hits: Hit[] = [];
  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    const parsed = parseWorkspaceHref(match[2]!);
    if (!parsed) continue;
    hits.push({
      index: match.index,
      end: match.index + match[0].length,
      path: parsed.path,
      fragment: parsed.fragment,
      label: match[1],
    });
  }
  for (const match of text.matchAll(TEXT_PATH_PATTERN)) {
    const index = match.index;
    // Skip matches embedded in a longer token (URLs, absolute paths) or
    // already consumed as a labeled markdown link.
    if (index > 0 && /[\w/@.:%+=-]/.test(text[index - 1]!)) continue;
    const end = index + match[0].length;
    if (hits.some((hit) => index >= hit.index && index < hit.end)) continue;
    hits.push({
      index,
      end,
      path: match[0].replace(/^\.\//, ""),
    });
  }
  hits.sort((a, b) => a.index - b.index);
  if (hits.length === 0) return [text];
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.index < cursor) continue;
    if (hit.index > cursor) nodes.push(text.slice(cursor, hit.index));
    nodes.push(
      <FileLink
        key={`f${hit.index}`}
        path={hit.path}
        fragment={hit.fragment}
        label={hit.label}
      />,
    );
    cursor = hit.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
