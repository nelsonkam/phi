import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

// Read-only serving of workspace files so messages can link them (see
// docs/mcp-tools.md §7). The workspace is the only filesystem surface agents
// have, so everything a message can legitimately reference lives under it.

export const FILES_ROUTE_PREFIX = "/api/v1/files/";

// Files above this size get a 413 instead of an inline response; the viewer
// is for reports, code, and images, not archives.
const MAX_INLINE_BYTES = 25 * 1024 * 1024;

// Resolves a workspace-relative (or absolute) path to a real file inside the
// workspace, or null. Symlinks are resolved *before* the containment check,
// so a link pointing outside the workspace cannot smuggle content in, and a
// `..` traversal cannot escape.
export function resolveWorkspaceFile(
  workspaceRoot: string,
  rawPath: string,
): string | null {
  if (rawPath.length === 0 || rawPath.includes("\0")) return null;
  let rootReal: string;
  try {
    rootReal = realpathSync(workspaceRoot);
  } catch {
    return null;
  }
  let real: string;
  try {
    real = realpathSync(resolve(rootReal, rawPath));
  } catch {
    return null; // missing file, dangling symlink
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

export function createFileHandler(
  workspaceRoot: string,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const pathname = new URL(req.url).pathname;
    if (!pathname.startsWith(FILES_ROUTE_PREFIX)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    let rawPath: string;
    try {
      rawPath = decodeURIComponent(pathname.slice(FILES_ROUTE_PREFIX.length));
    } catch {
      return Response.json({ error: "malformed path" }, { status: 400 });
    }
    const resolved = resolveWorkspaceFile(workspaceRoot, rawPath);
    if (!resolved) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const file = Bun.file(resolved);
    if (file.size > MAX_INLINE_BYTES) {
      return Response.json({ error: "file too large to view" }, { status: 413 });
    }
    const headers: Record<string, string> = {
      "content-type": file.type || "application/octet-stream",
      // Linked files are live references that agents keep mutating; never
      // let the browser pin a stale copy.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    // HTML renders statically in the viewer's iframe, and agent output is
    // untrusted data: inline styles, images, and sibling workspace assets may
    // load, but scripts never run and every channel back out is cut — no
    // fetch/XHR/websocket, no form posts, no <base> retargeting. This header
    // is the sole enforcement point: an iframe sandbox cannot be used, since
    // its opaque origin trips Chrome's private-network-access blocking for
    // localhost-served apps.
    if (/\.html?$/i.test(resolved)) {
      headers["content-security-policy"] =
        "default-src 'self' 'unsafe-inline' data: blob:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
    }
    return new Response(file, { headers });
  };
}
