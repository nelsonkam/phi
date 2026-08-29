// File-link detection that both the store (parent-thread fallback) and the
// chat renderer can share. A "link" is a markdown `[label](path)` or a bare
// workspace path token — not a substring of a longer token, and not prose
// that merely mentions a filename.

export const TEXT_PATH_PATTERN =
  /(?:\.\/)?[\w@%+=-][\w@%+=.-]*(?:\/[\w@%+=.-]+)+\.[A-Za-z0-9]{1,8}/g;

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// Decode each path segment once so an already-escaped href (`My%20Report.md`)
// is not encoded a second time when building the serving URL.
export function decodePathSegments(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

export function workspacePathFromHref(href: string): string | null {
  if (
    href.length === 0 ||
    SCHEME.test(href) ||
    href.startsWith("/") ||
    href.startsWith("#")
  ) {
    return null;
  }
  let end = href.length;
  const hash = href.indexOf("#");
  const query = href.indexOf("?");
  if (hash >= 0) end = Math.min(end, hash);
  if (query >= 0) end = Math.min(end, query);
  const path = decodePathSegments(href.slice(0, end).replace(/^\.\//, ""));
  return path || null;
}

function pathTokenAt(content: string, index: number): boolean {
  return index === 0 || !/[\w/@.:%+=-]/.test(content[index - 1]!);
}

export function messageContainsFileLink(content: string, path: string): boolean {
  const target = decodePathSegments(path.replace(/^\.\//, ""));
  for (const match of content.matchAll(new RegExp(MARKDOWN_LINK_PATTERN, "g"))) {
    if (workspacePathFromHref(match[2]!) === target) return true;
  }
  for (const match of content.matchAll(new RegExp(TEXT_PATH_PATTERN, "g"))) {
    const index = match.index ?? 0;
    if (!pathTokenAt(content, index)) continue;
    if (decodePathSegments(match[0].replace(/^\.\//, "")) === target) {
      return true;
    }
  }
  return false;
}
