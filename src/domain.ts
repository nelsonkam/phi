export type JobMode = "read_only" | "mutating";
export const workerEfforts = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type WorkerEffort = (typeof workerEfforts)[number];
export type JobStatus =
  | "queued"
  | "launching"
  | "running"
  | "needs_input"
  | "cancelling"
  | "completing"
  | "unknown"
  | "completed"
  | "failed"
  | "cancelled";
export type EventSource = "user" | "worker" | "system";
export type ObligationPolicy = "none" | "outbox";
export type MessageKind = "ack" | "progress" | "result" | "question";

export interface EventRecord {
  id: string;
  jobId: string | null;
  source: EventSource;
  kind: string;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  obligationPolicy: ObligationPolicy;
  createdAt: string;
  visibleAt: string | null;
  processingStartedAt: string | null;
  processedAt: string | null;
  error: string | null;
}

export interface JobRecord {
  id: string;
  workspaceId: string;
  sourceEventId: string;
  adapter: string;
  dispatchKey: string;
  externalRunId: string | null;
  continuationHandle: string | null;
  mode: JobMode;
  model: string | null;
  effort: WorkerEffort | null;
  status: JobStatus;
  prompt: string;
  observedStartCommit: string | null;
  observedTerminalCommit: string | null;
  error: string | null;
  cancelKey: string | null;
  cancelRequestedByEventId: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface OutboxRecord {
  id: string;
  eventId: string | null;
  kind: MessageKind;
  content: string;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: string;
}

export interface FollowUpRecord {
  id: string;
  jobId: string;
  sourceEventId: string;
  idempotencyKey: string;
  externalRunId: string;
  continuationHandle: string;
  content: string;
  status: "pending" | "sending" | "sent" | "failed" | "unknown" | "stale";
  createdAt: string;
  sendingStartedAt: string | null;
  sentAt: string | null;
  error: string | null;
}

export interface GitCheckpointRecord {
  id: string;
  workspaceId: string;
  commitSha: string;
  triggerJobId: string | null;
  status: string;
  createdAt: string;
}

export const terminalJobStatuses = new Set<JobStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export const activeJobStatuses = new Set<JobStatus>([
  "queued",
  "launching",
  "running",
  "cancelling",
  "completing",
]);
