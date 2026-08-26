// Message file-link convention: a relative href/path in a message refers to a
// workspace file. Channel-aware serving lives at
// /api/v1/channels/:id/file-roots/:root/<path>; /api/v1/files/<path> is the
// managed-workspace fallback. Anything with a scheme, an app-absolute path,
// or an anchor-only href is not a workspace reference.

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export const WORKSPACE_ROOT_ID = "workspace";

export function isWorkspaceHref(href: string): boolean {
  return (
    href.length > 0 &&
    !SCHEME.test(href) &&
    !href.startsWith("/") &&
    !href.startsWith("#")
  );
}

export function parseWorkspaceHref(href: string): {
  path: string;
  fragment?: string;
} | null {
  if (!isWorkspaceHref(href)) return null;
  const hash = href.indexOf("#");
  const query = href.indexOf("?");
  let end = href.length;
  if (hash >= 0) end = Math.min(end, hash);
  if (query >= 0) end = Math.min(end, query);
  const path = decodePathSegments(href.slice(0, end).replace(/^\.\//, ""));
  if (!path) return null;
  const fragment = hash >= 0 ? href.slice(hash + 1) : undefined;
  return { path, fragment: fragment || undefined };
}

// Decode each path segment once so an already-escaped href (`My%20Report.md`)
// is not encoded a second time when building the serving URL.
function decodePathSegments(path: string): string {
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

export function encodeFilePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

export function normalizePosix(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

// Join a file href to the directory of the markdown file that contains it.
export function resolveLinkedPath(path: string, baseDir?: string): string {
  const trimmed = path.replace(/^\.\//, "");
  if (!baseDir) return normalizePosix(trimmed);
  return normalizePosix(`${baseDir.replace(/\/+$/, "")}/${trimmed}`);
}

export function workspaceDirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

export function workspaceFileUrl(
  href: string,
  options?: { channelId?: string; root?: string; fragment?: string },
): string {
  const parsed = parseWorkspaceHref(href);
  const path = parsed?.path ?? decodePathSegments(href.replace(/^\.\//, ""));
  const encoded = encodeFilePath(path);
  const fragment = options?.fragment ?? parsed?.fragment;
  const suffix = fragment ? `#${fragment}` : "";
  if (options?.channelId && options.root) {
    return `/api/v1/channels/${encodeURIComponent(options.channelId)}/file-roots/${encodeURIComponent(options.root)}/${encoded}${suffix}`;
  }
  if (options?.channelId) {
    return `/api/v1/channels/${encodeURIComponent(options.channelId)}/files/${encoded}${suffix}`;
  }
  return `/api/v1/files/${encoded}${suffix}`;
}

export function parseFileApiUrl(url: string): {
  channelId?: string;
  root?: string;
  path: string;
} | null {
  let pathname: string;
  try {
    pathname = new URL(url, "http://local.invalid").pathname;
  } catch {
    return null;
  }
  const rooted = pathname.match(
    /^\/api\/v1\/channels\/([^/]+)\/file-roots\/([^/]+)\/(.*)$/,
  );
  if (rooted) {
    return {
      channelId: decodeURIComponent(rooted[1]!),
      root: decodeURIComponent(rooted[2]!),
      path: decodeURIComponent(rooted[3]!),
    };
  }
  const search = pathname.match(/^\/api\/v1\/channels\/([^/]+)\/files\/(.*)$/);
  if (search) {
    return {
      channelId: decodeURIComponent(search[1]!),
      path: decodeURIComponent(search[2]!),
    };
  }
  const workspace = pathname.match(/^\/api\/v1\/files\/(.*)$/);
  if (workspace) {
    return {
      root: WORKSPACE_ROOT_ID,
      path: decodeURIComponent(workspace[1]!),
    };
  }
  return null;
}

export function fileBasename(path: string): string {
  const clean = parseWorkspaceHref(path)?.path ?? path;
  return clean.split("/").at(-1) ?? clean;
}

export function fileExtension(path: string): string {
  const base = fileBasename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);

export type FileKind = "image" | "markdown" | "pdf" | "html" | "text";

// How the viewer should present a file. Everything unrecognized is attempted
// as text; the viewer falls back to a download link when the response isn't
// text-like. Query strings and fragments are not part of the filename.
export function fileKind(path: string): FileKind {
  const ext = fileExtension(path);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (HTML_EXTENSIONS.has(ext)) return "html";
  if (ext === "pdf") return "pdf";
  return "text";
}

// A conservative match for workspace paths in plain text: at least one "/",
// segments of word-ish characters, ending in an extension. Requiring the
// slash keeps prose like "node.js" plain.
export const TEXT_PATH_PATTERN =
  /(?:\.\/)?[\w@%+=-][\w@%+=.-]*(?:\/[\w@%+=.-]+)+\.[A-Za-z0-9]{1,8}/g;
