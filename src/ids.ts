import { createHash } from "node:crypto";

export function newId(): string {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export function semanticPart(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized)
    throw new Error("semantic key must contain a letter or number");
  return normalized.slice(0, 80);
}

export function dispatchKey(eventId: string, key: string): string {
  return `dispatch:${eventId}:${semanticPart(key)}`;
}

export function messageKey(event: {
  id: string;
  kind: string;
  jobId: string | null;
}): string {
  if (
    event.kind === "worker_completed" ||
    event.kind === "worker_failed" ||
    event.kind === "worker_cancelled"
  ) {
    if (!event.jobId) throw new Error("terminal worker event has no job");
    return `message:job:${event.jobId}:result`;
  }
  if (event.kind === "worker_needs_input")
    return `message:event:${event.id}:question`;
  return `message:event:${event.id}:primary`;
}

export function workerDedupeKey(
  adapter: string,
  externalRunId: string,
  nativeId: string | undefined,
  kind: string,
  payload: unknown,
): string {
  const suffix =
    nativeId ??
    createHash("sha256")
      .update(JSON.stringify([adapter, externalRunId, kind, payload]))
      .digest("hex");
  return `worker:${adapter}:${externalRunId}:${suffix}`;
}
