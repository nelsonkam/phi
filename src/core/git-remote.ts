import { readFileSync } from "node:fs";
import { gitRemotePath } from "@/core/paths";

export const GIT_REMOTE_COMMAND_TIMEOUT_MS = 15_000;
export const GIT_REMOTE_FLUSH_TIMEOUT_MS = 15_000;

export type RemoteErrorClass =
  | "push failed"
  | "authentication failed"
  | "timed out";

export type GitRemoteConfig =
  | { kind: "unset" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; url: string; displayUrl: string | null };

export function readGitRemoteConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): GitRemoteConfig {
  const fromEnv = env.PHI_GIT_REMOTE?.trim();
  if (fromEnv) return parseGitRemoteUrl(fromEnv);
  let raw: string;
  try {
    raw = readFileSync(gitRemotePath(root), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "unset" };
    return { kind: "invalid", error: "could not read git-remote file" };
  }
  const nonempty = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (nonempty.length === 0) return { kind: "unset" };
  if (nonempty.length > 1) {
    return { kind: "invalid", error: "git-remote file must be a single line" };
  }
  return parseGitRemoteUrl(nonempty[0]!);
}

export function parseGitRemoteUrl(raw: string): GitRemoteConfig {
  const url = raw.trim();
  if (!url) return { kind: "unset" };
  if (url.includes("\n") || url.includes("\r")) {
    return { kind: "invalid", error: "remote URL must be a single line" };
  }
  if (url.startsWith("-")) {
    return { kind: "invalid", error: "remote URL must not start with -" };
  }
  if (url === "origin") {
    return { kind: "invalid", error: "origin is the remote name, not a URL" };
  }
  if (/^[^@]*:[^@/]*@/.test(url)) {
    return { kind: "invalid", error: "remote URL must not contain a password" };
  }
  if (url.includes("://")) return parseRfcUrl(url);
  return parseScpUrl(url);
}

export function classifyRemoteError(error: unknown): RemoteErrorClass {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("timed out")) return "timed out";
  if (
    lower.includes("authentication") ||
    lower.includes("auth fail") ||
    lower.includes("could not read username") ||
    lower.includes("permission denied") ||
    lower.includes("publickey") ||
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("credential")
  ) {
    return "authentication failed";
  }
  return "push failed";
}

function parseRfcUrl(url: string): GitRemoteConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "invalid", error: "remote URL is not valid" };
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "ssh:" && protocol !== "file:") {
    return { kind: "invalid", error: `unsupported remote URL scheme ${parsed.protocol}` };
  }
  if (parsed.password) {
    return { kind: "invalid", error: "remote URL must not contain a password" };
  }
  if (protocol === "https:" && parsed.username) {
    return { kind: "invalid", error: "HTTPS remote URLs must not include userinfo" };
  }
  if (protocol === "https:" && (parsed.search || parsed.hash)) {
    return {
      kind: "invalid",
      error: "HTTPS remote URLs must not include a query or fragment",
    };
  }
  if (protocol === "file:" && (parsed.search || parsed.hash || parsed.username)) {
    return {
      kind: "invalid",
      error: "file remote URLs must not include userinfo, query, or fragment",
    };
  }
  return { kind: "ok", url, displayUrl: publicDisplayUrl(url, redactRfcUrl(parsed)) };
}

function parseScpUrl(url: string): GitRemoteConfig {
  const match = url.match(/^([^@\s:/]+)@([^@\s:]+):(.+)$/);
  if (!match) {
    return { kind: "invalid", error: "remote URL is not valid" };
  }
  const path = match[3]!;
  if (!path || path.startsWith("-")) {
    return { kind: "invalid", error: "remote URL is not valid" };
  }
  return { kind: "ok", url, displayUrl: publicDisplayUrl(url, url) };
}

function redactRfcUrl(parsed: URL): string {
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "file:") {
    return `file://${parsed.pathname}`;
  }
  const auth =
    parsed.username && protocol === "ssh:"
      ? `${parsed.username}@`
      : "";
  return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`;
}

function publicDisplayUrl(configured: string, redacted: string): string | null {
  return redacted === configured ? null : redacted;
}
