import { realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

// Read-only serving of workspace files so messages can link them (see
// docs/mcp-tools.md §7). A channel's roots are the managed workspace plus
// any attached folders; each root is addressed by a stable id so a link
// cannot be resolved against the wrong tree.

export const FILES_ROUTE_PREFIX = "/api/v1/files/";
export const WORKSPACE_ROOT_ID = "workspace";

const CHANNEL_SEARCH_RE = /^\/api\/v1\/channels\/([^/]+)\/files\/(.*)$/;
const CHANNEL_ROOT_RE =
  /^\/api\/v1\/channels\/([^/]+)\/file-roots\/([^/]+)\/(.*)$/;
const WORKSPACE_FILES_RE = /^\/api\/v1\/files\/(.*)$/;

// Files above this size get a 413 instead of an inline response; the viewer
// is for reports, code, and images, not archives.
const MAX_INLINE_BYTES = 25 * 1024 * 1024;

export interface FileRoot {
  id: string;
  path: string;
}

export interface FileChannelLookup {
  getChannel(id: string): { folders: string[] } | null;
}

export type FileResolveResult =
  | { ok: true; file: string; root: FileRoot }
  | { ok: false; reason: "not_found" | "ambiguous" | "bad_root"; rootIds?: string[] };

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

// `workspace` is reserved. Attached folders use their basename, with a
// numeric suffix when that name collides inside the same channel.
export function listFileRoots(
  workspaceRoot: string,
  folders: string[] = [],
): FileRoot[] {
  const used = new Set<string>([WORKSPACE_ROOT_ID]);
  const roots: FileRoot[] = [{ id: WORKSPACE_ROOT_ID, path: workspaceRoot }];
  for (const folder of folders) {
    let id = basename(folder) || "folder";
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    used.add(id);
    roots.push({ id, path: folder });
  }
  return roots;
}

export function resolveFileInRoots(
  roots: FileRoot[],
  rawPath: string,
  rootId?: string,
): FileResolveResult {
  if (rootId !== undefined) {
    const root = roots.find((item) => item.id === rootId);
    if (!root) return { ok: false, reason: "bad_root" };
    const file = resolveWorkspaceFile(root.path, rawPath);
    if (!file) return { ok: false, reason: "not_found" };
    return { ok: true, file, root };
  }
  const matches: { file: string; root: FileRoot }[] = [];
  for (const root of roots) {
    const file = resolveWorkspaceFile(root.path, rawPath);
    if (file) matches.push({ file, root });
  }
  if (matches.length === 1) return { ok: true, ...matches[0]! };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      rootIds: matches.map((match) => match.root.id),
    };
  }
  return { ok: false, reason: "not_found" };
}

export function encodeFilePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

export function createFileHandler(
  workspaceRoot: string,
  channels?: FileChannelLookup,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const pathname = new URL(req.url).pathname;
    const parsed = parseFilesPath(pathname);
    if (!parsed) {
      return jsonError("not found", 404);
    }

    let rawPath: string;
    try {
      rawPath = decodeURIComponent(parsed.rest);
    } catch {
      return jsonError("malformed path", 400);
    }

    if (parsed.kind === "workspace") {
      return serveResolved(resolveWorkspaceFile(workspaceRoot, rawPath));
    }

    if (!channels) return jsonError("not found", 404);
    const channel = channels.getChannel(parsed.channelId);
    if (!channel) return jsonError("not found", 404);
    const roots = listFileRoots(workspaceRoot, channel.folders);

    if (parsed.kind === "root") {
      let rootId: string;
      try {
        rootId = decodeURIComponent(parsed.rootId);
      } catch {
        return jsonError("malformed path", 400);
      }
      const result = resolveFileInRoots(roots, rawPath, rootId);
      if (!result.ok) return jsonError("not found", 404);
      return serveResolved(result.file);
    }

    const result = resolveFileInRoots(roots, rawPath);
    if (!result.ok) {
      if (result.reason === "ambiguous") {
        return Response.json(
          { error: "ambiguous", roots: result.rootIds },
          { status: 409 },
        );
      }
      return jsonError("not found", 404);
    }
    const location = `/api/v1/channels/${encodeURIComponent(parsed.channelId)}/file-roots/${encodeURIComponent(result.root.id)}/${encodeFilePath(rawPath)}`;
    return new Response(null, {
      status: 302,
      headers: { location },
    });
  };
}

function parseFilesPath(pathname: string):
  | { kind: "workspace"; rest: string }
  | { kind: "search"; channelId: string; rest: string }
  | { kind: "root"; channelId: string; rootId: string; rest: string }
  | null {
  const rooted = pathname.match(CHANNEL_ROOT_RE);
  if (rooted) {
    return {
      kind: "root",
      channelId: rooted[1]!,
      rootId: rooted[2]!,
      rest: rooted[3]!,
    };
  }
  const search = pathname.match(CHANNEL_SEARCH_RE);
  if (search) {
    return { kind: "search", channelId: search[1]!, rest: search[2]! };
  }
  const workspace = pathname.match(WORKSPACE_FILES_RE);
  if (workspace) {
    return { kind: "workspace", rest: workspace[1]! };
  }
  return null;
}

function serveResolved(resolved: string | null): Response {
  if (!resolved) {
    return jsonError("not found", 404);
  }
  const file = Bun.file(resolved);
  if (file.size > MAX_INLINE_BYTES) {
    return jsonError("file too large to view", 413);
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
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}
