import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { deviceTokenPath } from "@/core/paths";

export const DEVICE_COOKIE = "phi-device";
export const DEVICE_TOKEN_PREFIX = "phi_dt_";
const DEVICE_TOKEN_RE = /^phi_dt_[a-f0-9]{64}$/;

// Durable per-server device secret for human attachment (and later API) access.
// Native clients send `Authorization: Bearer`. The browser receives an HttpOnly
// cookie from GET /api/v1/auth/session on loopback. MCP session tokens are a
// different registry and never match this format.
export class DeviceAuth {
  readonly localToken: string;
  private readonly hashes: Buffer[];

  constructor(root: string, options?: { extraSecrets?: string[] }) {
    this.localToken = loadOrCreateToken(root);
    const secrets = [this.localToken];
    const envToken = process.env.PHI_API_TOKEN?.trim();
    if (envToken && envToken.length >= 16 && envToken !== this.localToken) {
      secrets.push(envToken);
    }
    for (const extra of options?.extraSecrets ?? []) {
      if (extra && extra !== this.localToken) secrets.push(extra);
    }
    this.hashes = secrets.map(sha256);
  }

  authorize(req: Request): boolean {
    const presented = bearerToken(req) ?? cookieToken(req);
    if (!presented) return false;
    const digest = sha256(presented);
    return this.hashes.some((hash) => safeEqual(digest, hash));
  }

  unauthorized(): Response {
    return Response.json(
      { error: "unauthorized" },
      {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="phi"' },
      },
    );
  }

  setCookieHeader(): string {
    return `${DEVICE_COOKIE}=${this.localToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
  }
}

export function requireDeviceAuth(
  auth: DeviceAuth,
  req: Request,
): Response | null {
  return auth.authorize(req) ? null : auth.unauthorized();
}

export function sessionResponse(
  auth: DeviceAuth,
  req: Request,
  loopback: boolean,
): Response {
  if (auth.authorize(req)) {
    return Response.json({ ok: true });
  }
  if (loopback) {
    return Response.json(
      { ok: true },
      { headers: { "set-cookie": auth.setCookieHeader() } },
    );
  }
  return auth.unauthorized();
}

export function bearerToken(req: Request): string | null {
  const match = req.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

export function cookieToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${DEVICE_COOKIE}=`)) {
      return trimmed.slice(DEVICE_COOKIE.length + 1);
    }
  }
  return null;
}

function loadOrCreateToken(root: string): string {
  const path = deviceTokenPath(root);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (DEVICE_TOKEN_RE.test(existing)) return existing;
  }
  const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on filesystems that ignore mode.
  }
  return token;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
