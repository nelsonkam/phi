// Remark plugin that wraps valid @mentions in markdown text nodes so they
// render as <span class="mention"> pills. Mirrors the validation rules of
// renderMentions in mentions.tsx: agent-name grammar, no trailing-word-char
// matches (e-mail local parts), registry-validated names only.

const MENTION_PATTERN = /@([a-z0-9][a-z0-9-]*)/gi;

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: unknown;
}

export function remarkMentions(known: ReadonlySet<string>) {
  return () => (tree: MdastNode) => {
    if (known.size > 0) walk(tree, known);
  };
}

function walk(node: MdastNode, known: ReadonlySet<string>): void {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.type === "text" && typeof child.value === "string") {
      const replaced = splitTextNode(child.value, known);
      if (replaced) {
        children.splice(i, 1, ...replaced);
        i += replaced.length - 1;
      }
    } else if (child.type !== "link") {
      // Code and inlineCode are value nodes (no children); links keep their
      // own styling.
      walk(child, known);
    }
  }
}

function splitTextNode(
  text: string,
  known: ReadonlySet<string>,
): MdastNode[] | null {
  if (!text.includes("@")) return null;
  const nodes: MdastNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const index = match.index;
    if (index > 0 && /[\w@]/.test(text[index - 1]!)) continue;
    if (!known.has(match[1]!.toLowerCase())) continue;
    if (index > cursor) {
      nodes.push({ type: "text", value: text.slice(cursor, index) });
    }
    // A `strong` node whose data overrides the hast output: mdast-util-to-hast
    // honors hName/hProperties for handled types, yielding a styled span
    // instead of <strong>.
    nodes.push({
      type: "strong",
      children: [{ type: "text", value: match[0] }],
      data: { hName: "span", hProperties: { className: "mention" } },
    });
    cursor = index + match[0].length;
  }
  if (nodes.length === 0) return null;
  if (cursor < text.length) {
    nodes.push({ type: "text", value: text.slice(cursor) });
  }
  return nodes;
}
