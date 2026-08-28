import { readFileSync } from "node:fs";
import { listFileRoots, resolveFileInRoots } from "@/server/files";
import type { PhiStore } from "@/core/store/store";
import {
  MAX_AFFIX_CHARS,
  MAX_HEADING_SLUG_CHARS,
  MAX_QUOTE_CHARS,
} from "@/shared/doc-comment-anchor";

export interface ParsedDocCommentBody {
  content: string;
  rootId: string;
  path: string;
  quote: string;
  prefix: string;
  suffix: string;
  headingSlug: string | null;
}

export type ParseDocCommentResult =
  | { ok: true; value: ParsedDocCommentBody }
  | { ok: false; error: string; status: number };

export function parseDocCommentBody(body: unknown): ParseDocCommentResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid body", status: 400 };
  }
  const rec = body as Record<string, unknown>;
  const content = typeof rec.content === "string" ? rec.content.trim() : "";
  const rootId = typeof rec.rootId === "string" ? rec.rootId.trim() : "";
  const path = typeof rec.path === "string" ? rec.path.trim() : "";
  const quote = typeof rec.quote === "string" ? rec.quote : "";
  const prefix = typeof rec.prefix === "string" ? rec.prefix : "";
  const suffix = typeof rec.suffix === "string" ? rec.suffix : "";
  const headingSlug =
    typeof rec.headingSlug === "string" && rec.headingSlug.trim()
      ? rec.headingSlug.trim()
      : null;
  if (!rootId) return { ok: false, error: "rootId is required", status: 400 };
  if (!path) return { ok: false, error: "path is required", status: 400 };
  if (!quote) return { ok: false, error: "quote is required", status: 400 };
  if (quote.length > MAX_QUOTE_CHARS) {
    return { ok: false, error: "quote is too long", status: 400 };
  }
  if (prefix.length > MAX_AFFIX_CHARS || suffix.length > MAX_AFFIX_CHARS) {
    return { ok: false, error: "anchor context is too long", status: 400 };
  }
  if (headingSlug && headingSlug.length > MAX_HEADING_SLUG_CHARS) {
    return { ok: false, error: "headingSlug is too long", status: 400 };
  }
  return {
    ok: true,
    value: { content, rootId, path, quote, prefix, suffix, headingSlug },
  };
}

export function resolveMarkdownDoc(
  store: PhiStore,
  workspaceRoot: string,
  channelId: string,
  rootId: string,
  path: string,
):
  | { ok: true; file: string }
  | { ok: false; error: string; status: number } {
  const channel = store.getChannel(channelId);
  if (!channel) return { ok: false, error: "not found", status: 404 };
  if (!isMarkdownPath(path)) {
    return { ok: false, error: "comments are only supported on markdown files", status: 400 };
  }
  const roots = listFileRoots(workspaceRoot, channel.folders);
  const resolved = resolveFileInRoots(roots, path, rootId);
  if (!resolved.ok) {
    return { ok: false, error: "not found", status: 404 };
  }
  return { ok: true, file: resolved.file };
}

export function readWorkspaceFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isMarkdownPath(path: string): boolean {
  const base = path.split(/[/?#]/).at(-1) ?? path;
  return /\.(md|markdown)$/i.test(base);
}
