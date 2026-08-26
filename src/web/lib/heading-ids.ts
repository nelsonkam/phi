// GitHub-style heading slugs so markdown fragments (`report.md#summary`)
// can target the rendered document. IDs are assigned in the remark tree
// before React sees the headings.

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: {
    hProperties?: Record<string, string>;
  };
}

export function slugifyHeading(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function uniqueHeadingId(
  text: string,
  used: Map<string, number>,
): string {
  const base = slugifyHeading(text) || "section";
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

export function mdastText(node: MdastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(mdastText).join("");
}

export function remarkHeadingIds() {
  return (tree: MdastNode) => {
    const used = new Map<string, number>();
    assignHeadingIds(tree, used);
  };
}

function assignHeadingIds(node: MdastNode, used: Map<string, number>): void {
  if (node.type === "heading") {
    const id = uniqueHeadingId(mdastText(node), used);
    node.data = node.data ?? {};
    node.data.hProperties = { ...node.data.hProperties, id };
  }
  for (const child of node.children ?? []) {
    assignHeadingIds(child, used);
  }
}

export function headingIdFromChildren(
  id: string | undefined,
  children: unknown,
): string | undefined {
  if (id) return id;
  const text = reactNodeText(children);
  return text ? slugifyHeading(text) : undefined;
}

function reactNodeText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return reactNodeText(props?.children);
  }
  return "";
}

export function decodeHeadingFragment(fragment: string): string {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Looks up a heading by fragment. Tries the decoded id first, then the
// slugified form, so `#Summary` still matches `id="summary"`.
export interface HeadingQueryRoot {
  querySelector(selector: string): HeadingTarget | null;
}

export interface HeadingTarget {
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
}

export function findHeadingTarget(
  root: HeadingQueryRoot,
  fragment: string,
): HeadingTarget | null {
  const decoded = decodeHeadingFragment(fragment);
  if (!decoded) return null;
  const direct = queryById(root, decoded);
  if (direct) return direct;
  const slug = slugifyHeading(decoded);
  if (slug && slug !== decoded) return queryById(root, slug);
  return null;
}

export function scrollToHeadingFragment(
  root: HeadingQueryRoot,
  fragment: string,
): HeadingTarget | null {
  const target = findHeadingTarget(root, fragment);
  target?.scrollIntoView({ block: "start" });
  return target;
}

function queryById(root: HeadingQueryRoot, id: string): HeadingTarget | null {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return root.querySelector(`#${escaped}`);
}
