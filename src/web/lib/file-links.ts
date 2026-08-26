// Message file-link convention: a relative href/path in a message refers to a
// workspace file, served read-only at /api/v1/files/<path>. Anything with a
// scheme, an app-absolute path, or an anchor is not a workspace reference.

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function isWorkspaceHref(href: string): boolean {
  return (
    href.length > 0 &&
    !SCHEME.test(href) &&
    !href.startsWith("/") &&
    !href.startsWith("#")
  );
}

// Normalizes a workspace-relative href to its serving URL, percent-encoding
// each segment but keeping the separators.
export function workspaceFileUrl(href: string): string {
  const clean = href.replace(/^\.\//, "");
  return `/api/v1/files/${clean.split("/").map(encodeURIComponent).join("/")}`;
}

export function fileBasename(path: string): string {
  return path.split("/").at(-1) ?? path;
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
// text-like.
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
