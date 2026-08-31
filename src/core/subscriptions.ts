import type { SchedulerService } from "@/core/scheduler";
import type { PhiStore } from "@/core/store/store";
import type { Message } from "@/shared/types";

const SUBSCRIPTION_HANDLER = "resource-subscription";
const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const GITHUB_PULL_REQUEST_EVENT_TYPES = [
  "state_changed",
  "draft_changed",
  "review_decision_changed",
  "checks_failed",
  "checks_passed",
  "new_review",
  "new_comment",
  "new_commit",
  "labels_changed",
  "assignees_changed",
  "mergeability_changed",
] as const;
export type GithubPullRequestEventType =
  (typeof GITHUB_PULL_REQUEST_EVENT_TYPES)[number];
export const DEFAULT_GITHUB_PULL_REQUEST_EVENTS: GithubPullRequestEventType[] = [
  "state_changed",
  "draft_changed",
  "review_decision_changed",
  "checks_failed",
  "checks_passed",
  "new_review",
  "new_commit",
];
const GH_PR_FIELDS = [
  "assignees",
  "baseRefName",
  "comments",
  "commits",
  "headRefName",
  "headRefOid",
  "isDraft",
  "labels",
  "mergeable",
  "mergeStateStatus",
  "number",
  "reviewDecision",
  "reviews",
  "state",
  "statusCheckRollup",
  "title",
  "updatedAt",
  "url",
].join(",");

export interface ResourceSubscription {
  id: string;
  workspaceId: string;
  threadId: string;
  provider: "github";
  resourceKind: "pull_request";
  resourceKey: string;
  resourceUrl: string;
  events: GithubPullRequestEventType[];
  active: boolean;
  lastPolledAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscribeResult {
  subscription: ResourceSubscription;
  created: boolean;
}

interface SubscriptionRow {
  id: string;
  workspace_id: string;
  thread_id: string;
  provider: string;
  resource_kind: string;
  resource_key: string;
  resource_url: string;
  state_json: string;
  events_json: string;
  active: number;
  last_polled_at: string | null;
  last_event_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface GithubPullRequestRef {
  owner: string;
  repo: string;
  number: number;
  key: string;
  url: string;
}

interface PullRequestSnapshot {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  updatedAt: string;
  commentCount: number;
  reviewCount: number;
  commitCount: number;
  labels: string[];
  assignees: string[];
  checks: Array<{ name: string; status: string; conclusion: string }>;
}

interface PullRequestEvent {
  type: GithubPullRequestEventType;
  summary: string;
}

export interface SubscriptionServiceOptions {
  pollIntervalMs?: number;
  now?: () => Date;
  runGh?: (args: string[]) => Promise<string>;
  threadAgent: (threadId: string) => Promise<string>;
  onEvent: (message: Message, routedTo: string[]) => void;
}

export class SubscriptionService {
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly runGh: (args: string[]) => Promise<string>;

  constructor(
    private readonly store: PhiStore,
    private readonly scheduler: SchedulerService,
    private readonly options: SubscriptionServiceOptions,
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.runGh = options.runGh ?? runGh;
    this.scheduler.registerHandler(SUBSCRIPTION_HANDLER, async (payload) => {
      const id = typeof payload.subscriptionId === "string"
        ? payload.subscriptionId
        : "";
      if (!id) throw new Error("subscription task is missing subscriptionId");
      await this.poll(id);
    });
    this.restoreTasks();
  }

  async subscribe(
    threadId: string,
    resource: string,
    requestedEvents?: string[],
  ): Promise<SubscribeResult> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Current thread no longer exists");
    const ref = parseGithubPullRequest(resource);
    const events = normalizeSubscriptionEvents(requestedEvents);
    const existing = this.find(threadId, ref.key);
    if (existing) {
      const now = this.now().toISOString();
      if (existing.active) {
        this.store.db
          .query(
            `UPDATE resource_subscriptions
             SET events_json = ?, updated_at = ? WHERE id = ?`,
          )
          .run(JSON.stringify(events), now, existing.id);
      } else {
        const snapshot = await this.readPullRequest(ref.url);
        this.store.db
          .query(
            `UPDATE resource_subscriptions
             SET resource_url = ?, state_json = ?, events_json = ?, active = 1,
                 last_polled_at = ?, last_error = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            snapshot.url || ref.url,
            JSON.stringify(snapshot),
            JSON.stringify(events),
            now,
            now,
            existing.id,
          );
      }
      this.ensureTask(existing.id);
      return {
        subscription: subscriptionFromRow(this.get(existing.id)!),
        created: false,
      };
    }

    const snapshot = await this.readPullRequest(ref.url);
    const id = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = this.now().toISOString();
    this.store.db
      .query(
        `INSERT INTO resource_subscriptions
           (id, workspace_id, thread_id, provider, resource_kind, resource_key,
            resource_url, state_json, events_json, active, last_polled_at,
            created_at, updated_at)
         VALUES (?, ?, ?, 'github', 'pull_request', ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        thread.workspaceId,
        threadId,
        ref.key,
        snapshot.url || ref.url,
        JSON.stringify(snapshot),
        JSON.stringify(events),
        now,
        now,
        now,
      );
    this.ensureTask(id);
    return { subscription: subscriptionFromRow(this.get(id)!), created: true };
  }

  async poll(id: string): Promise<void> {
    const row = this.get(id);
    if (!row || !row.active) return;
    try {
      const previous = JSON.parse(row.state_json) as PullRequestSnapshot;
      const current = await this.readPullRequest(row.resource_url);
      const polledAt = this.now().toISOString();
      if (JSON.stringify(current) === JSON.stringify(previous)) {
        this.store.db
          .query(
            `UPDATE resource_subscriptions
             SET last_polled_at = ?, last_error = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(polledAt, polledAt, id);
        return;
      }

      const selected = new Set(subscriptionEventsFromRow(row));
      const events = pullRequestEvents(previous, current).filter((event) =>
        selected.has(event.type),
      );
      this.store.db
        .query(
          `UPDATE resource_subscriptions
           SET state_json = ?, resource_url = ?, last_polled_at = ?,
               last_event_at = COALESCE(?, last_event_at),
               last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(current),
          current.url || row.resource_url,
          polledAt,
          events.length > 0 ? polledAt : null,
          polledAt,
          id,
        );
      if (events.length === 0) return;
      const agent = await this.options.threadAgent(row.thread_id);
      const message = this.store.appendMessage(row.thread_id, {
        author: "system",
        kind: "resource_event",
        content: pullRequestEventMessage(row.resource_key, current, events),
        metadata: {
          subscriptionId: row.id,
          provider: "github",
          resourceKind: "pull_request",
          resourceKey: row.resource_key,
          resourceUrl: current.url || row.resource_url,
          eventTypes: events.map((event) => event.type),
          routedTo: [agent],
        },
      });
      this.options.onEvent(message, [agent]);
    } catch (error) {
      const failedAt = this.now().toISOString();
      this.store.db
        .query(
          `UPDATE resource_subscriptions
           SET last_polled_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(failedAt, errorText(error), failedAt, id);
      throw error;
    }
  }

  private restoreTasks(): void {
    const rows = this.store.db
      .query<SubscriptionRow, []>(
        "SELECT * FROM resource_subscriptions WHERE active = 1 ORDER BY id",
      )
      .all();
    for (const row of rows) this.ensureTask(row.id);
  }

  private ensureTask(id: string): void {
    this.scheduler.upsertTask({
      id: `subscription.${id}`,
      handler: SUBSCRIPTION_HANDLER,
      schedule: { kind: "interval", everyMs: this.pollIntervalMs },
      payload: { subscriptionId: id },
      catchUp: "run_once",
    });
  }

  private get(id: string): SubscriptionRow | null {
    return this.store.db
      .query<SubscriptionRow, [string]>(
        "SELECT * FROM resource_subscriptions WHERE id = ?",
      )
      .get(id);
  }

  private find(threadId: string, key: string): SubscriptionRow | null {
    return this.store.db
      .query<SubscriptionRow, [string, string]>(
        `SELECT * FROM resource_subscriptions
         WHERE thread_id = ? AND provider = 'github'
           AND resource_kind = 'pull_request' AND resource_key = ?`,
      )
      .get(threadId, key);
  }

  private async readPullRequest(url: string): Promise<PullRequestSnapshot> {
    const raw = await this.runGh([
      "pr",
      "view",
      url,
      "--json",
      GH_PR_FIELDS,
    ]);
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error("gh returned invalid JSON for the pull request");
    }
    return normalizePullRequest(value);
  }
}

export function parseGithubPullRequest(resource: string): GithubPullRequestRef {
  const trimmed = resource.trim();
  const url = trimmed.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i,
  );
  const shorthand = trimmed.match(/^([^/\s]+)\/([^/#\s]+)#(\d+)$/);
  const match = url ?? shorthand;
  if (!match) {
    throw new Error(
      "resource must be a GitHub pull request URL or owner/repo#number",
    );
  }
  const owner = match[1]!;
  const repo = match[2]!.replace(/\.git$/i, "");
  const number = Number(match[3]);
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  return {
    owner,
    repo,
    number,
    key,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

export function normalizeSubscriptionEvents(
  requested?: readonly string[],
): GithubPullRequestEventType[] {
  if (requested === undefined) return [...DEFAULT_GITHUB_PULL_REQUEST_EVENTS];
  if (requested.length === 0) {
    throw new Error("events must contain at least one event type");
  }
  const supported = new Set<string>(GITHUB_PULL_REQUEST_EVENT_TYPES);
  const unknown = [...new Set(requested)].filter((event) => !supported.has(event));
  if (unknown.length > 0) {
    throw new Error(
      `unsupported pull request event${unknown.length === 1 ? "" : "s"}: ${unknown.join(
        ", ",
      )}; supported events: ${GITHUB_PULL_REQUEST_EVENT_TYPES.join(", ")}`,
    );
  }
  const selected = new Set(requested);
  return GITHUB_PULL_REQUEST_EVENT_TYPES.filter((event) => selected.has(event));
}

async function runGh(args: string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new Error(`gh could not read the pull request: ${detail}`);
  }
  return stdout;
}

function normalizePullRequest(value: Record<string, unknown>): PullRequestSnapshot {
  return {
    number: numberValue(value.number),
    url: stringValue(value.url),
    title: stringValue(value.title),
    state: stringValue(value.state),
    isDraft: value.isDraft === true,
    mergeable: stringValue(value.mergeable),
    mergeStateStatus: stringValue(value.mergeStateStatus),
    reviewDecision: stringValue(value.reviewDecision),
    baseRefName: stringValue(value.baseRefName),
    headRefName: stringValue(value.headRefName),
    headRefOid: stringValue(value.headRefOid),
    updatedAt: stringValue(value.updatedAt),
    commentCount: arrayValue(value.comments).length,
    reviewCount: arrayValue(value.reviews).length,
    commitCount: arrayValue(value.commits).length,
    labels: arrayValue(value.labels)
      .map((item) => stringValue(recordValue(item).name))
      .filter(Boolean)
      .sort(),
    assignees: arrayValue(value.assignees)
      .map((item) => stringValue(recordValue(item).login))
      .filter(Boolean)
      .sort(),
    checks: arrayValue(value.statusCheckRollup)
      .map((item) => {
        const check = recordValue(item);
        return {
          name:
            stringValue(check.name) ||
            stringValue(check.context) ||
            stringValue(check.workflowName),
          status: stringValue(check.status) || stringValue(check.state),
          conclusion: stringValue(check.conclusion),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function pullRequestEventMessage(
  key: string,
  current: PullRequestSnapshot,
  events: PullRequestEvent[],
): string {
  return `GitHub PR event for [${key}: ${current.title}](${current.url}):\n\n${events
    .map((event) => `- ${event.summary}`)
    .join("\n")}`;
}

function pullRequestEvents(
  previous: PullRequestSnapshot,
  current: PullRequestSnapshot,
): PullRequestEvent[] {
  const events: PullRequestEvent[] = [];
  addChangedEvent(events, "state_changed", "State", previous.state, current.state);
  addChangedEvent(
    events,
    "draft_changed",
    "Draft",
    yesNo(previous.isDraft),
    yesNo(current.isDraft),
  );
  addChangedEvent(
    events,
    "review_decision_changed",
    "Review decision",
    previous.reviewDecision,
    current.reviewDecision,
  );

  const beforeChecks = checkCounts(previous.checks);
  const afterChecks = checkCounts(current.checks);
  const previousFailures = new Set(failedCheckNames(previous.checks));
  const newFailures = failedCheckNames(current.checks).filter(
    (name) => !previousFailures.has(name),
  );
  if (newFailures.length > 0) {
    events.push({
      type: "checks_failed",
      summary: `Checks failed: ${newFailures.join(", ")} (${checkSummary(
        current.checks,
      )})`,
    });
  }
  if (
    afterChecks.total > 0 &&
    afterChecks.passing === afterChecks.total &&
    (beforeChecks.total === 0 || beforeChecks.passing !== beforeChecks.total)
  ) {
    events.push({
      type: "checks_passed",
      summary: `Checks passed: ${checkSummary(current.checks)}`,
    });
  }

  addIncreaseEvent(
    events,
    "new_review",
    "review",
    previous.reviewCount,
    current.reviewCount,
  );
  addIncreaseEvent(
    events,
    "new_comment",
    "comment",
    previous.commentCount,
    current.commentCount,
  );
  addIncreaseEvent(
    events,
    "new_commit",
    "commit",
    previous.commitCount,
    current.commitCount,
  );
  addChangedEvent(
    events,
    "labels_changed",
    "Labels",
    previous.labels.join(", "),
    current.labels.join(", "),
  );
  addChangedEvent(
    events,
    "assignees_changed",
    "Assignees",
    previous.assignees.join(", "),
    current.assignees.join(", "),
  );
  addChangedEvent(
    events,
    "mergeability_changed",
    "Mergeability",
    mergeabilitySummary(previous),
    mergeabilitySummary(current),
  );
  return events;
}

function addChangedEvent(
  events: PullRequestEvent[],
  type: GithubPullRequestEventType,
  label: string,
  previous: string,
  current: string,
): void {
  if (previous === current) return;
  events.push({
    type,
    summary: `${label}: ${display(previous)} → ${display(current)}`,
  });
}

function addIncreaseEvent(
  events: PullRequestEvent[],
  type: GithubPullRequestEventType,
  label: string,
  previous: number,
  current: number,
): void {
  const added = current - previous;
  if (added <= 0) return;
  events.push({
    type,
    summary: `${added} new ${label}${added === 1 ? "" : "s"} (${current} total)`,
  });
}

function checkSummary(checks: PullRequestSnapshot["checks"]): string {
  const counts = checkCounts(checks);
  if (counts.total === 0) return "none";
  return `${counts.passing} passing, ${counts.failing} failing, ${counts.pending} pending`;
}

function checkCounts(checks: PullRequestSnapshot["checks"]): {
  total: number;
  passing: number;
  failing: number;
  pending: number;
} {
  const passing = checks.filter((check) =>
    ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.conclusion || check.status),
  ).length;
  const failing = checks.filter((check) =>
    ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(
      check.conclusion || check.status,
    ),
  ).length;
  const pending = checks.length - passing - failing;
  return { total: checks.length, passing, failing, pending };
}

function failedCheckNames(checks: PullRequestSnapshot["checks"]): string[] {
  return checks
    .filter((check) =>
      ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(
        check.conclusion || check.status,
      ),
    )
    .map((check) => check.name || "unnamed check");
}

function mergeabilitySummary(snapshot: PullRequestSnapshot): string {
  return [snapshot.mergeable, snapshot.mergeStateStatus]
    .filter(Boolean)
    .join(" / ");
}

function subscriptionFromRow(row: SubscriptionRow): ResourceSubscription {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    provider: "github",
    resourceKind: "pull_request",
    resourceKey: row.resource_key,
    resourceUrl: row.resource_url,
    events: subscriptionEventsFromRow(row),
    active: row.active === 1,
    lastPolledAt: row.last_polled_at,
    lastEventAt: row.last_event_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function subscriptionEventsFromRow(
  row: Pick<SubscriptionRow, "events_json">,
): GithubPullRequestEventType[] {
  try {
    const value = JSON.parse(row.events_json) as unknown;
    return Array.isArray(value)
      ? normalizeSubscriptionEvents(value.map(String))
      : [...DEFAULT_GITHUB_PULL_REQUEST_EVENTS];
  } catch {
    return [...DEFAULT_GITHUB_PULL_REQUEST_EVENTS];
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function display(value: string | number): string {
  return value === "" ? "none" : String(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
