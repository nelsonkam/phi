export type CoordinatorTraceKind = "tool" | "reasoning" | "output";
export type CoordinatorTraceState = "running" | "completed" | "failed";

export interface CoordinatorTraceEntry {
  id: string;
  kind: CoordinatorTraceKind;
  title: string;
  content: string;
  createdAt: string;
  state?: CoordinatorTraceState;
}

export class CoordinatorTraceStore {
  private readonly entries = new Map<string, CoordinatorTraceEntry>();

  constructor(private readonly limit = 500) {}

  get(id: string): CoordinatorTraceEntry | undefined {
    return this.entries.get(id);
  }

  upsert(entry: CoordinatorTraceEntry): void {
    const previous = this.entries.get(entry.id);
    this.entries.set(entry.id, {
      ...entry,
      createdAt: previous?.createdAt ?? entry.createdAt,
    });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  list(): CoordinatorTraceEntry[] {
    return [...this.entries.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  }
}
