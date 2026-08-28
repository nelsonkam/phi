import {
  captureTextQuote,
  locateTextQuote,
  type TextQuote,
} from "@/shared/doc-comment-anchor";

export const COMMENT_INELIGIBLE_ATTR = "data-comment-ineligible";

export interface ProjectionNode {
  node: Text;
  start: number;
  end: number;
}

export interface TextProjection {
  text: string;
  nodes: ProjectionNode[];
}

export function isCommentIneligible(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(el?.closest(`[${COMMENT_INELIGIBLE_ATTR}]`));
}

export function buildTextProjection(root: Element): TextProjection {
  const nodes: ProjectionNode[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  let current: Node | null = walker.nextNode();
  while (current) {
    if (current instanceof Text && !isCommentIneligible(current)) {
      const value = current.nodeValue ?? "";
      if (value.length > 0) {
        nodes.push({
          node: current,
          start: text.length,
          end: text.length + value.length,
        });
        text += value;
      }
    }
    current = walker.nextNode();
  }
  return { text, nodes };
}

export function captureSelectionAnchor(
  root: Element,
  selection: Selection,
): (TextQuote & { headingSlug: string | null }) | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const projection = buildTextProjection(root);
  const start = offsetInProjection(projection, range.startContainer, range.startOffset);
  const end = offsetInProjection(projection, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  const quote = captureTextQuote(projection.text, start, end);
  if (!quote.quote.trim()) return null;
  return {
    ...quote,
    headingSlug: nearestHeadingSlug(root, range.startContainer),
  };
}

export function rangeFromMatch(
  projection: TextProjection,
  start: number,
  end: number,
): Range | null {
  const startHit = nodeAt(projection, start, false);
  const endHit = nodeAt(projection, end, true);
  if (!startHit || !endHit) return null;
  const range = document.createRange();
  range.setStart(startHit.node, startHit.offset);
  range.setEnd(endHit.node, endHit.offset);
  return range;
}

export interface HighlightAnchor {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  className: string;
}

// Locate every quote against one projection (character offsets stay valid
// across wraps), then wrap longest-first, rebuilding the live node map after
// each wrap so later ranges never see split/moved Text nodes.
export function paintDocCommentHighlights(
  root: Element,
  comments: HighlightAnchor[],
): HTMLElement[] {
  const projection = buildTextProjection(root);
  const located: Array<{ comment: HighlightAnchor; start: number; end: number }> =
    [];
  for (const comment of comments) {
    const match = locateTextQuote(
      projection.text,
      comment.quote,
      comment.prefix,
      comment.suffix,
    );
    if (!match) continue;
    located.push({ comment, start: match.start, end: match.end });
  }
  located.sort((a, b) => {
    const length = b.end - b.start - (a.end - a.start);
    if (length !== 0) return length;
    return a.start - b.start;
  });
  const painted: HTMLElement[] = [];
  for (const item of located) {
    const live = buildTextProjection(root);
    const range = rangeFromMatch(live, item.start, item.end);
    if (!range) continue;
    painted.push(...wrapRange(range, item.comment.id, item.comment.className));
  }
  return painted;
}

export function unwrapDocCommentMarks(marks: HTMLElement[]): void {
  for (let i = marks.length - 1; i >= 0; i--) unwrapMark(marks[i]!);
}

function wrapRange(range: Range, threadId: string, className: string): HTMLElement[] {
  const marks: HTMLElement[] = [];
  for (const text of textNodesInRange(range)) {
    if (isCommentIneligible(text)) continue;
    let from = 0;
    let to = text.data.length;
    if (text === range.startContainer) from = range.startOffset;
    if (text === range.endContainer) to = range.endOffset;
    if (to <= from) continue;
    const slice = text.splitText(from);
    if (slice.data.length > to - from) slice.splitText(to - from);
    const mark = document.createElement("mark");
    mark.dataset.docComment = threadId;
    mark.className = className;
    slice.parentNode?.insertBefore(mark, slice);
    mark.appendChild(slice);
    marks.push(mark);
  }
  return marks;
}

function textNodesInRange(range: Range): Text[] {
  const texts: Text[] = [];
  if (range.commonAncestorContainer instanceof Text) {
    if (!isCommentIneligible(range.commonAncestorContainer)) {
      texts.push(range.commonAncestorContainer);
    }
    return texts;
  }
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
  );
  let node: Node | null = walker.nextNode();
  while (node) {
    if (
      node instanceof Text &&
      range.intersectsNode(node) &&
      !isCommentIneligible(node)
    ) {
      texts.push(node);
    }
    node = walker.nextNode();
  }
  return texts;
}

function unwrapMark(mark: HTMLElement): void {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  parent.normalize();
}

function nodeIn(ancestor: Node, node: Node): boolean {
  return ancestor === node || ancestor.contains(node);
}

function firstNodeIn(
  projection: TextProjection,
  ancestor: Node,
): ProjectionNode | undefined {
  return projection.nodes.find((item) => nodeIn(ancestor, item.node));
}

function lastNodeIn(
  projection: TextProjection,
  ancestor: Node,
): ProjectionNode | undefined {
  for (let i = projection.nodes.length - 1; i >= 0; i--) {
    const item = projection.nodes[i]!;
    if (nodeIn(ancestor, item.node)) return item;
  }
  return undefined;
}

// Range offsets on an Element are child indexes (triple-click / selectNodeContents
// uses this). Text containers use a character offset into that node.
function offsetInProjection(
  projection: TextProjection,
  container: Node,
  offset: number,
): number | null {
  if (container instanceof Text) {
    const hit = projection.nodes.find((item) => item.node === container);
    if (!hit) return null;
    return hit.start + Math.min(Math.max(0, offset), hit.end - hit.start);
  }
  const kids = container.childNodes;
  if (offset <= 0) return firstNodeIn(projection, container)?.start ?? null;
  if (offset >= kids.length) {
    return lastNodeIn(projection, container)?.end ?? null;
  }
  const at = kids[offset]!;
  const first = firstNodeIn(projection, at);
  if (first) return first.start;
  const prev = kids[offset - 1];
  return prev ? (lastNodeIn(projection, prev)?.end ?? null) : null;
}

function nodeAt(
  projection: TextProjection,
  offset: number,
  end: boolean,
): { node: Text; offset: number } | null {
  for (const item of projection.nodes) {
    if (end) {
      if (offset > item.start && offset <= item.end) {
        return { node: item.node, offset: offset - item.start };
      }
    } else if (offset >= item.start && offset < item.end) {
      return { node: item.node, offset: offset - item.start };
    }
  }
  if (end && offset === 0 && projection.nodes[0]) {
    return { node: projection.nodes[0].node, offset: 0 };
  }
  const last = projection.nodes.at(-1);
  if (last && offset === last.end) {
    return { node: last.node, offset: last.end - last.start };
  }
  return null;
}

function nearestHeadingSlug(root: Element, node: Node): string | null {
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return null;
  const headings = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")];
  let best: Element | null = null;
  for (const heading of headings) {
    const pos = heading.compareDocumentPosition(el);
    if (
      heading === el ||
      heading.contains(el) ||
      pos & Node.DOCUMENT_POSITION_FOLLOWING
    ) {
      best = heading;
    }
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) break;
  }
  const id = best?.getAttribute("id");
  return id || null;
}

export { locateTextQuote };
