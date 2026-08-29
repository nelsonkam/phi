import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { locateTextQuote } from "@/shared/doc-comment-anchor";

const SURROUNDING_LINES = 12;

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  position?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

export interface DocSourceContext {
  path: string;
  quote: string;
  surrounding: string | null;
  parentThreadId?: string | null;
}

// Map a rendered quote onto the markdown source via an mdast text
// projection, then extract nearby source lines for the agent prompt.
export function docSourceContext(
  source: string,
  path: string,
  quote: string,
  prefix: string,
  suffix: string,
): DocSourceContext {
  return {
    path,
    quote,
    surrounding: surroundingSource(source, quote, prefix, suffix),
  };
}

export function formatDocCommentContext(ctx: DocSourceContext): string {
  const lines = [
    `This turn is a comment thread on a markdown document (${ctx.path}). The quoted text is the excerpt the user selected. Reply as marginalia, focused on the selected passage: the user is looking at the document, so never quote it back or re-summarize it. When the user asked for an edit or clearly authorized one, make it and confirm briefly ("Tightened that paragraph") rather than describing the change you would make; otherwise discuss first. If the discussion outgrows the excerpt — it's really about the whole document or new work — suggest continuing in the main channel, or create and link a doc when broader work was requested, instead of building it in the margin.`,
    `Quoted text:\n${ctx.quote}`,
  ];
  if (ctx.surrounding) {
    lines.push(`Surrounding source:\n\`\`\`\n${ctx.surrounding}\n\`\`\``);
  }
  if (ctx.parentThreadId) {
    lines.push(
      `Parent thread: ${ctx.parentThreadId}. Use read_thread with that id to pull the sharing conversation. To surface a resolution in the channel flow, send_message with thread_id set to that parent.`,
    );
  }
  return lines.join("\n\n");
}

function surroundingSource(
  source: string,
  quote: string,
  prefix: string,
  suffix: string,
): string | null {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as MdastNode;
  const pieces: { start: number; end: number; line: number }[] = [];
  const chunks: string[] = [];
  walkText(tree, (node, text) => {
    const start = chunks.reduce((n, chunk) => n + chunk.length, 0);
    chunks.push(text);
    pieces.push({
      start,
      end: start + text.length,
      line: node.position?.start.line ?? 1,
    });
  });
  const match = locateTextQuote(chunks.join(""), quote, prefix, suffix);
  if (!match) {
    const raw = source.indexOf(quote);
    if (raw < 0) return null;
    const line = source.slice(0, raw).split("\n").length;
    return sliceLines(source, line, line);
  }
  const startLine = lineAt(pieces, match.start);
  const endLine = lineAt(pieces, Math.max(match.start, match.end - 1));
  return sliceLines(source, startLine, endLine);
}

function walkText(
  node: MdastNode,
  visit: (node: MdastNode, text: string) => void,
): void {
  if (typeof node.value === "string" && node.value.length > 0) {
    visit(node, node.value);
  }
  for (const child of node.children ?? []) walkText(child, visit);
}

function lineAt(
  pieces: { start: number; end: number; line: number }[],
  offset: number,
): number {
  for (const piece of pieces) {
    if (offset >= piece.start && offset < piece.end) return piece.line;
  }
  return pieces.at(-1)?.line ?? 1;
}

function sliceLines(source: string, startLine: number, endLine: number): string {
  const lines = source.split("\n");
  const from = Math.max(0, startLine - 1 - SURROUNDING_LINES);
  const to = Math.min(lines.length, endLine + SURROUNDING_LINES);
  return lines.slice(from, to).join("\n");
}
