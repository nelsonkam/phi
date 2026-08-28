import { mkdir, rename, unlink } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { PhiStore } from "@/core/store/store";
import { uploadsPath } from "@/core/paths";
import {
  ATTACHMENT_ID_RE,
  DEFAULT_UPLOAD_MAX_BYTES,
  declaredMime,
  isAttachmentId,
  parseByteLimit,
  sanitizeFilename,
} from "@/shared/attachments";
import type { Attachment } from "@/shared/types";

export { DEFAULT_UPLOAD_MAX_BYTES, parseByteLimit, sanitizeFilename };
export { attachmentsFromMetadata } from "@/shared/attachments";

export class UploadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super("file too large");
    this.name = "UploadTooLargeError";
  }
}

const HTML_CSP =
  "default-src 'self' 'unsafe-inline' data: blob:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";

// Multipart wrapping is a few KB; reject obviously huge requests before
// reading the body. The file-byte cap is enforced while streaming.
const MULTIPART_OVERHEAD = 1024 * 1024;

export function newAttachmentId(): string {
  return `att_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function resolveContentType(
  declared: string | undefined,
  filename: string,
): string {
  const mime = declaredMime(declared);
  if (mime && mime !== "application/octet-stream") return mime;
  const detected = Bun.file(filename.toLowerCase()).type;
  return detected || mime || "application/octet-stream";
}

export function parseFilenameHeader(
  contentDisposition: string | null,
  fallbackHeader: string | null,
): string {
  if (fallbackHeader?.trim()) return sanitizeFilename(fallbackHeader);
  if (!contentDisposition) return "file";
  const star = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) {
    try {
      return sanitizeFilename(decodeURIComponent(star[1]!.trim()));
    } catch {
      // Fall through to the ASCII filename parameter.
    }
  }
  const quoted = contentDisposition.match(/filename\s*=\s*"((?:\\.|[^"])*)"/i);
  if (quoted) return sanitizeFilename(quoted[1]!.replace(/\\"/g, '"'));
  const plain = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
  if (plain) return sanitizeFilename(plain[1]!.trim());
  return "file";
}

export async function writeStreamToFile(
  stream: ReadableStream<Uint8Array>,
  dest: string,
  maxBytes: number,
): Promise<number> {
  await mkdir(dirname(dest), { recursive: true });
  await unlink(dest).catch(() => {});
  const writer = Bun.file(dest).writer();
  const reader = stream.getReader();
  let written = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maxBytes) {
        await writer.end();
        await unlink(dest).catch(() => {});
        throw new UploadTooLargeError(maxBytes);
      }
      writer.write(value);
    }
    await writer.flush();
    await writer.end();
    return written;
  } catch (error) {
    try {
      await writer.end();
    } catch {
      // Sink may already be closed after the size-cap path.
    }
    await unlink(dest).catch(() => {});
    throw error;
  }
}

export function createAttachmentHandlers(
  store: PhiStore,
  options?: { maxBytes?: number; multipartOverhead?: number },
): {
  post: (req: Request) => Promise<Response>;
  get: (req: Request, params: { id: string }) => Promise<Response>;
  meta: (req: Request, params: { id: string }) => Promise<Response>;
} {
  const maxBytes = options?.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
  const multipartOverhead = options?.multipartOverhead ?? MULTIPART_OVERHEAD;
  const root = store.rootPath;

  return {
    post: (req) => handleUpload(req, store, root, maxBytes, multipartOverhead),
    get: (req, params) => handleDownload(req, store, root, params.id),
    meta: (_req, params) => handleMeta(store, params.id),
  };
}

async function handleUpload(
  req: Request,
  store: PhiStore,
  root: string,
  maxBytes: number,
  multipartOverhead: number,
): Promise<Response> {
  const length = contentLength(req);
  const contentType = req.headers.get("content-type") ?? "";
  const multipart = contentType.toLowerCase().includes("multipart/form-data");
  const cap = multipart ? maxBytes + multipartOverhead : maxBytes;
  if (length !== undefined && length > cap) {
    return jsonError("file too large", 413);
  }

  const id = newAttachmentId();
  const tmp = join(uploadsPath(root), ".tmp", `${id}.part`);
  const dest = join(uploadsPath(root), id);

  let filename: string;
  let declared: string | undefined;
  let byteSize: number;
  try {
    if (multipart) {
      const parsed = await readBoundedMultipart(
        req,
        contentType,
        cap,
        `${tmp}.form`,
      );
      const file = parsed.get("file");
      if (!(file instanceof Blob) || file.size === 0) {
        return jsonError("file is required", 400);
      }
      if (file.size > maxBytes) return jsonError("file too large", 413);
      const named = file as Blob & { name?: string };
      filename = sanitizeFilename(named.name || "file");
      declared = named.type || undefined;
      byteSize = await writeStreamToFile(file.stream(), tmp, maxBytes);
    } else {
      const body = req.body;
      if (!body) return jsonError("file is required", 400);
      filename = parseFilenameHeader(
        req.headers.get("content-disposition"),
        req.headers.get("x-phi-filename"),
      );
      declared = contentType || undefined;
      byteSize = await writeStreamToFile(body, tmp, maxBytes);
      if (byteSize === 0) {
        await unlink(tmp).catch(() => {});
        return jsonError("file is required", 400);
      }
    }
    await mkdir(uploadsPath(root), { recursive: true });
    await rename(tmp, dest);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    if (error instanceof UploadTooLargeError) {
      return jsonError("file too large", 413);
    }
    if (error instanceof UploadEmptyError) {
      return jsonError("file is required", 400);
    }
    throw error;
  }

  const resolvedType = resolveContentType(declared, filename);
  let attachment: Attachment;
  try {
    attachment = store.createAttachment({
      id,
      workspaceId: store.defaultWorkspace().id,
      filename,
      contentType: resolvedType,
      byteSize,
    });
  } catch (error) {
    await unlink(dest).catch(() => {});
    throw error;
  }

  return Response.json({ attachment }, { status: 201 });
}

async function handleDownload(
  req: Request,
  store: PhiStore,
  root: string,
  rawId: string,
): Promise<Response> {
  const attachment = lookupAttachment(store, rawId);
  if (!attachment) return jsonError("not found", 404);
  const filePath = resolveUploadFile(root, attachment.id);
  if (!filePath) return jsonError("not found", 404);
  const file = Bun.file(filePath);
  const download = new URL(req.url).searchParams.get("download") === "1";
  const headers: Record<string, string> = {
    "content-type": attachment.contentType,
    "content-disposition": contentDisposition(
      download ? "attachment" : "inline",
      attachment.filename,
    ),
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  };
  if (
    attachment.contentType.includes("html") ||
    /\.html?$/i.test(attachment.filename)
  ) {
    headers["content-security-policy"] = HTML_CSP;
  }
  return new Response(file, { headers });
}

async function handleMeta(
  store: PhiStore,
  rawId: string,
): Promise<Response> {
  const attachment = lookupAttachment(store, rawId);
  if (!attachment) return jsonError("not found", 404);
  return Response.json({ attachment });
}

function lookupAttachment(store: PhiStore, rawId: string): Attachment | null {
  if (!isAttachmentId(rawId)) return null;
  return store.getAttachment(rawId);
}

async function readBoundedMultipart(
  req: Request,
  contentType: string,
  cap: number,
  tmpPath: string,
): Promise<FormData> {
  const body = req.body;
  if (!body) {
    throw new UploadEmptyError();
  }
  await writeStreamToFile(body, tmpPath, cap);
  try {
    // Bun.file() as a Request body does not parse as multipart (missing
    // final boundary). The envelope is already size-capped on disk.
    const bytes = await Bun.file(tmpPath).bytes();
    return await new Response(bytes, {
      headers: { "content-type": contentType },
    }).formData();
  } catch (error) {
    if (error instanceof UploadTooLargeError) throw error;
    throw new UploadEmptyError();
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

class UploadEmptyError extends Error {
  constructor() {
    super("file is required");
    this.name = "UploadEmptyError";
  }
}

// Containment after symlink resolution, same posture as workspace file serving.
export function resolveUploadFile(root: string, id: string): string | null {
  if (!ATTACHMENT_ID_RE.test(id) || id.includes("\0")) return null;
  let uploadsReal: string;
  try {
    uploadsReal = realpathSync(uploadsPath(root));
  } catch {
    return null;
  }
  let real: string;
  try {
    real = realpathSync(resolve(uploadsReal, id));
  } catch {
    return null;
  }
  if (real !== uploadsReal && !real.startsWith(uploadsReal + sep)) return null;
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

function contentLength(req: Request): number | undefined {
  const raw = req.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function contentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

const PROMPT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

export async function attachmentPromptParts(
  root: string,
  attachments: Attachment[],
  canSendImages: boolean,
): Promise<{
  note: string | undefined;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}> {
  if (attachments.length === 0) return { note: undefined, images: [] };
  const lines = attachments.map((item) => {
    const tooBig =
      canSendImages &&
      item.contentType.startsWith("image/") &&
      item.byteSize > PROMPT_IMAGE_MAX_BYTES;
    const extra = tooBig ? " (too large to embed in the prompt)" : "";
    return `- ${item.filename} (${item.contentType}, ${item.byteSize} bytes) attachment:${item.id}${extra}`;
  });
  const note = `The user attached ${attachments.length === 1 ? "a file" : `${attachments.length} files`}. These are server-owned attachments, not workspace paths — do not treat a client filesystem path as a server path.\n${lines.join("\n")}`;
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  if (!canSendImages) return { note, images };
  for (const item of attachments) {
    if (!item.contentType.startsWith("image/")) continue;
    if (item.byteSize > PROMPT_IMAGE_MAX_BYTES) continue;
    const filePath = resolveUploadFile(root, item.id);
    if (!filePath) continue;
    const bytes = await Bun.file(filePath).arrayBuffer();
    images.push({
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType: item.contentType,
    });
  }
  return { note, images };
}
