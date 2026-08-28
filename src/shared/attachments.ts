// Client-neutral attachment identifiers and hrefs. Bytes live on HTTP
// (`/api/v1/attachments/:id`); message text and WebSocket frames carry only
// the id plus filename/type/size metadata.

export const ATTACHMENT_ID_RE = /^att_[a-f0-9]{32}$/;

export const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_UPLOAD_MAX_FILES = 20;

const ATTACHMENT_SCHEME = /^attachment:(att_[a-f0-9]{32})$/i;
const ATTACHMENT_API = /^\/api\/v1\/attachments\/(att_[a-f0-9]{32})$/i;

export function isAttachmentId(id: string): boolean {
  return ATTACHMENT_ID_RE.test(id);
}

export function attachmentApiPath(id: string): string {
  return `/api/v1/attachments/${id}`;
}

export function attachmentMetaPath(id: string): string {
  return `/api/v1/attachments/${id}/meta`;
}

export function parseAttachmentHref(href: string): { id: string } | null {
  if (!href) return null;
  const scheme = href.match(ATTACHMENT_SCHEME);
  if (scheme) return { id: scheme[1]!.toLowerCase() };
  let pathname = href;
  try {
    pathname = new URL(href, "http://local.invalid").pathname;
  } catch {
    return null;
  }
  const api = pathname.match(ATTACHMENT_API);
  if (!api) return null;
  return { id: api[1]!.toLowerCase() };
}

const MAX_FILENAME = 255;

// Basename only: strip paths, NULs/controls, Windows-reserved chars. Empty
// or `.` / `..` become `file`. Length is capped, keeping a short extension.
export function sanitizeFilename(raw: string): string {
  let name = raw.replace(/\\/g, "/");
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  name = name.replace(/[\u0000-\u001f\u007f]/g, "");
  name = name.replace(/[<>:"|?*]/g, "_");
  name = name.trim();
  if (!name || name === "." || name === "..") return "file";
  if (name.length <= MAX_FILENAME) return name;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && name.length - dot <= 16) {
    const ext = name.slice(dot);
    const base = name.slice(0, Math.max(1, MAX_FILENAME - ext.length));
    return base + ext;
  }
  return name.slice(0, MAX_FILENAME);
}

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

export function declaredMime(raw: string | undefined): string | undefined {
  const cleaned = raw?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!cleaned || !MIME_RE.test(cleaned)) return undefined;
  return cleaned;
}

export function parseByteLimit(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function attachmentsFromMetadata(
  metadata: Record<string, unknown>,
): Array<{
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
}> {
  const raw = metadata.attachments;
  if (!Array.isArray(raw)) return [];
  const result: Array<{
    id: string;
    filename: string;
    contentType: string;
    byteSize: number;
    createdAt: string;
  }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.id !== "string" ||
      !isAttachmentId(rec.id) ||
      typeof rec.filename !== "string" ||
      typeof rec.contentType !== "string" ||
      typeof rec.byteSize !== "number"
    ) {
      continue;
    }
    result.push({
      id: rec.id,
      filename: rec.filename,
      contentType: rec.contentType,
      byteSize: rec.byteSize,
      createdAt: typeof rec.createdAt === "string" ? rec.createdAt : "",
    });
  }
  return result;
}
