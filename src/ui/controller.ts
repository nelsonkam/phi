import type { PhiApp } from "../app.ts";
import {
  activeJobStatuses,
  type JobRecord,
  type MessageKind,
} from "../domain.ts";
import type { WorkerDescriptor } from "../workers/adapter.ts";
import type { CoordinatorTraceEntry } from "../coordinator/trace.ts";

export interface ConversationEntry {
  id: string;
  role: "user" | "phi";
  kind: "user" | MessageKind;
  content: string;
  createdAt: string;
}

export interface ActivityEntry {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
}

export interface PhiUiSnapshot {
  conversation: ConversationEntry[];
  coordinatorTraces: CoordinatorTraceEntry[];
  activities: ActivityEntry[];
  workers: WorkerDescriptor[];
  status: string;
  notice: string | null;
}

function jobTitle(job: JobRecord): string {
  return `${job.status.replaceAll("_", " ")} · ${job.adapter}${job.model ? `/${job.model}` : ""}`;
}

export class PhiUiController {
  private listeners = new Set<(snapshot: PhiUiSnapshot) => void>();
  private timer: Timer | null = null;
  private workers: WorkerDescriptor[] = [];
  private notice: string | null = null;
  private lastSerialized = "";

  constructor(readonly app: PhiApp) {}

  async initialize(): Promise<void> {
    await this.refreshWorkers();
    this.emit(true);
  }

  snapshot(): PhiUiSnapshot {
    const conversation: ConversationEntry[] = [];
    const activities: ActivityEntry[] = [];
    const jobs = this.app.store.listJobs();
    for (const event of this.app.store.listEvents()) {
      if (event.kind === "user_message")
        conversation.push({
          id: event.id,
          role: "user",
          kind: "user",
          content: String(event.payload.content ?? ""),
          createdAt: event.createdAt,
        });
      else if (event.source === "worker") {
        activities.push({
          id: event.id,
          title: event.kind.replaceAll("_", " "),
          detail: String(
            event.payload.message ??
              event.payload.summary ??
              event.payload.error ??
              "",
          ),
          createdAt: event.createdAt,
        });
      }
    }
    for (const message of this.app.store.listMessages())
      conversation.push({
        id: message.id,
        role: "phi",
        kind: message.kind,
        content: message.content,
        createdAt: message.createdAt,
      });
    for (const job of jobs)
      activities.push({
        id: job.id,
        title: jobTitle(job),
        detail: job.error ?? job.prompt,
        createdAt: job.updatedAt,
      });
    conversation.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
    activities.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    );
    const active = jobs.filter((job) =>
      activeJobStatuses.has(job.status),
    ).length;
    const needsInput = jobs.filter(
      (job) => job.status === "needs_input",
    ).length;
    const status = needsInput
      ? `Input needed · ${needsInput} ${needsInput === 1 ? "activity" : "activities"}`
      : active
        ? `Working · ${active} ${active === 1 ? "activity" : "activities"}`
        : "Ready";
    return {
      conversation,
      coordinatorTraces: this.app.coordinatorTraces.list(),
      activities,
      workers: this.workers,
      status,
      notice: this.notice,
    };
  }

  subscribe(listener: (snapshot: PhiUiSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    if (!this.timer)
      this.timer = setInterval(() => {
        this.emit();
      }, 100);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  async submit(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    this.notice = null;
    await this.app.submitUserMessage(trimmed);
    this.emit(true);
  }

  async refreshWorkers(): Promise<void> {
    this.workers = await this.app.adapters.describeAll();
    this.emit(true);
  }

  async loginCursor(): Promise<void> {
    this.notice = "Opening Cursor SDK login…";
    this.emit(true);
    try {
      const status = await this.app.adapters.authenticate("cursor", {
        onLoginUrl: (url) => {
          this.notice = `Complete Cursor login in your browser: ${url}`;
          this.emit(true);
        },
      });
      this.notice = status.detail;
      await this.refreshWorkers();
    } catch (error) {
      this.notice = `Cursor login failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emit(true);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private emit(force = false): void {
    const snapshot = this.snapshot();
    const serialized = JSON.stringify(snapshot);
    if (!force && serialized === this.lastSerialized) return;
    this.lastSerialized = serialized;
    for (const listener of this.listeners) listener(snapshot);
  }
}
