import type { SchedulerService } from "@/core/scheduler";
import type { PhiStore } from "@/core/store/store";
import type { Message } from "@/shared/types";

const SUBSCRIPTION_HANDLER = "resource-subscription";
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const CURSOR_API_BASE = "https://api.cursor.com";
const CURSOR_AGENT_ID_PATTERN = /^bc-[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const GITHUB_PULL_REQUEST_EVENT_TYPES = [
  "github.state_changed",
  "github.draft_changed",
  "github.review_decision_changed",
  "github.checks_failed",
  "github.checks_passed",
  "github.new_review",
  "github.new_comment",
  "github.new_commit",
  "github.labels_changed",
  "github.assignees_changed",
  "github.mergeability_changed",
] as const;
export type GithubPullRequestEventType =
  (typeof GITHUB_PULL_REQUEST_EVENT_TYPES)[number];
export const DEFAULT_GITHUB_PULL_REQUEST_EVENTS: GithubPullRequestEventType[] = [
  "github.state_changed",
  "github.draft_changed",
  "github.review_decision_changed",
  "github.checks_failed",
  "github.checks_passed",
  "github.new_review",
  "github.new_commit",
];
export const CURSOR_CLOUD_AGENT_EVENT_TYPES = [
  "cursor.status_changed",
  "cursor.new_run",
  "cursor.run_status_changed",
  "cursor.run_finished",
  "cursor.run_failed",
  "cursor.run_cancelled",
  "cursor.pr_opened",
  "cursor.branch_changed",
] as const;
export type CursorCloudAgentEventType =
  (typeof CURSOR_CLOUD_AGENT_EVENT_TYPES)[number];
export const DEFAULT_CURSOR_CLOUD_AGENT_EVENTS: CursorCloudAgentEventType[] = [
  "cursor.status_changed",
  "cursor.run_finished",
  "cursor.run_failed",
  "cursor.pr_opened",
];
export const SUBSCRIPTION_EVENT_TYPES = [
  ...GITHUB_PULL_REQUEST_EVENT_TYPES,
  ...CURSOR_CLOUD_AGENT_EVENT_TYPES,
] as const;
export type SubscriptionEventType = (typeof SUBSCRIPTION_EVENT_TYPES)[number];
export type SubscriptionResourceKind = "pull_request" | "cloud_agent";
const LEGACY_GITHUB_EVENT_NAMES: Record<string, GithubPullRequestEventType> =
  Object.fromEntries(
    GITHUB_PULL_REQUEST_EVENT_TYPES.map((event) => [
      event.slice("github.".length),
      event,
    ]),
  );
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
  provider: "github" | "cursor";
  resourceKind: SubscriptionResourceKind;
  resourceKey: string;
  resourceUrl: string;
  events: SubscriptionEventType[];
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

export interface UnsubscribeResult {
  unsubscribed: true;
  subscription: ResourceSubscription;
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
  poll_generation: number;
  created_at: string;
  updated_at: string;
}

interface GithubPullRequestRef {
  provider: "github";
  resourceKind: "pull_request";
  owner: string;
  repo: string;
  number: number;
  key: string;
  url: string;
}

interface CursorCloudAgentRef {
  provider: "cursor";
  resourceKind: "cloud_agent";
  key: string;
  url: string;
}

export type SubscriptionResourceRef = GithubPullRequestRef | CursorCloudAgentRef;

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

interface CursorBranchSnapshot {
  repoUrl: string;
  branch: string;
  prUrl: string;
}

export interface CursorRunSnapshot {
  id: string;
  status: string;
  result: string;
}

export interface CursorRunPage {
  items: CursorRunSnapshot[];
  nextCursor?: string;
}

export interface CursorCloudAgentSnapshot {
  id: string;
  name: string;
  status: string;
  url: string;
  latestRunId: string;
  runId: string;
  runStatus: string;
  runResult: string;
  branches: CursorBranchSnapshot[];
}

const CURSOR_RUN_LIST_LIMIT = 100;
const CURSOR_RUN_LIST_MAX_PAGES = 100;
const CURSOR_TERMINAL_RUN_STATUSES = new Set([
  "FINISHED",
  "ERROR",
  "CANCELLED",
  "EXPIRED",
]);

type ResourceSnapshot = PullRequestSnapshot | CursorCloudAgentSnapshot;

interface ResourceEvent {
  type: SubscriptionEventType;
  summary: string;
}

export interface SubscriptionServiceOptions {
  pollIntervalMs?: number;
  now?: () => Date;
  runGh?: (args: string[]) => Promise<string>;
  readCursorAgent?: (id: string) => Promise<CursorCloudAgentSnapshot>;
  readCursorRun?: (agentId: string, runId: string) => Promise<CursorRunSnapshot>;
  listCursorRuns?: (
    agentId: string,
    query?: { cursor?: string; limit?: number },
  ) => Promise<CursorRunPage>;
  getCursorApiKey?: () => string | undefined;
  threadAgent: (threadId: string) => Promise<string>;
  onEvent: (message: Message, routedTo: string[]) => void;
}

export class SubscriptionService {
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly runGh: (args: string[]) => Promise<string>;
  private readonly readCursorAgent: (
    id: string,
  ) => Promise<CursorCloudAgentSnapshot>;
  private readonly readCursorRun: (
    agentId: string,
    runId: string,
  ) => Promise<CursorRunSnapshot>;
  private readonly listCursorRuns: (
    agentId: string,
    query?: { cursor?: string; limit?: number },
  ) => Promise<CursorRunPage>;

  constructor(
    private readonly store: PhiStore,
    private readonly scheduler: SchedulerService,
    private readonly options: SubscriptionServiceOptions,
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.runGh = options.runGh ?? runGh;
    const apiKey = options.getCursorApiKey ?? cursorApiKeyFromEnv;
    this.readCursorAgent =
      options.readCursorAgent ?? ((id) => defaultReadCursorAgent(id, apiKey));
    this.readCursorRun =
      options.readCursorRun ??
      ((agentId, runId) => defaultReadCursorRun(agentId, runId, apiKey));
    this.listCursorRuns =
      options.listCursorRuns ??
      ((agentId, query) => defaultListCursorRuns(agentId, query, apiKey));
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
    const ref = parseSubscriptionResource(resource);
    const events = normalizeSubscriptionEvents(ref.resourceKind, requestedEvents);
    const existing = this.find(
      threadId,
      ref.provider,
      ref.resourceKind,
      ref.key,
    );
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
        const snapshot = await this.readSnapshotForRef(ref);
        this.store.db
          .query(
            `UPDATE resource_subscriptions
             SET resource_url = ?, state_json = ?, events_json = ?, active = 1,
                 last_polled_at = ?, last_error = NULL,
                 poll_generation = poll_generation + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            snapshotUrl(snapshot, ref.url),
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

    const snapshot = await this.readSnapshotForRef(ref);
    const id = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = this.now().toISOString();
    this.store.db
      .query(
        `INSERT INTO resource_subscriptions
           (id, workspace_id, thread_id, provider, resource_kind, resource_key,
            resource_url, state_json, events_json, active, last_polled_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        thread.workspaceId,
        threadId,
        ref.provider,
        ref.resourceKind,
        ref.key,
        snapshotUrl(snapshot, ref.url),
        JSON.stringify(snapshot),
        JSON.stringify(events),
        now,
        now,
        now,
      );
    this.ensureTask(id);
    return { subscription: subscriptionFromRow(this.get(id)!), created: true };
  }

  async unsubscribe(
    threadId: string,
    resource: string,
  ): Promise<UnsubscribeResult> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Current thread no longer exists");
    const ref = parseSubscriptionResource(resource);
    const existing = this.find(
      threadId,
      ref.provider,
      ref.resourceKind,
      ref.key,
    );
    if (!existing) {
      throw new Error("no subscription for this resource in the current thread");
    }
    const now = this.now().toISOString();
    this.store.db
      .query(
        `UPDATE resource_subscriptions
         SET active = 0, poll_generation = poll_generation + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, existing.id);
    this.scheduler.deleteTask(`subscription.${existing.id}`);
    return {
      unsubscribed: true,
      subscription: subscriptionFromRow(this.get(existing.id)!),
    };
  }

  async poll(id: string): Promise<void> {
    const row = this.get(id);
    if (!row || !row.active) return;
    const generation = row.poll_generation;
    try {
      const previous = JSON.parse(row.state_json) as ResourceSnapshot;
      const current = await this.readSnapshotForRow(row);
      if (!this.pollStillCurrent(id, generation)) return;
      const polledAt = this.now().toISOString();
      if (JSON.stringify(current) === JSON.stringify(previous)) {
        this.commitPollWrite(
          `UPDATE resource_subscriptions
           SET last_polled_at = ?, last_error = NULL, updated_at = ?
           WHERE poll_generation = ? AND active = 1 AND id = ?`,
          [polledAt, polledAt, generation, id],
        );
        return;
      }

      const selected = new Set(subscriptionEventsFromRow(row));
      const events = (
        await this.resourceEvents(row, previous, current)
      ).filter((event) => selected.has(event.type));
      if (
        !this.commitPollWrite(
          `UPDATE resource_subscriptions
           SET state_json = ?, resource_url = ?, last_polled_at = ?,
               last_event_at = COALESCE(?, last_event_at),
               last_error = NULL, updated_at = ?
           WHERE poll_generation = ? AND active = 1 AND id = ?`,
          [
            JSON.stringify(current),
            snapshotUrl(current, row.resource_url),
            polledAt,
            events.length > 0 ? polledAt : null,
            polledAt,
            generation,
            id,
          ],
        )
      ) {
        return;
      }
      if (events.length === 0) return;
      const agent = await this.options.threadAgent(row.thread_id);
      if (!this.pollStillCurrent(id, generation)) return;
      const message = this.store.appendMessage(row.thread_id, {
        author: "system",
        kind: "resource_event",
        content: resourceEventMessage(row, current, events),
        metadata: {
          subscriptionId: row.id,
          provider: row.provider,
          resourceKind: row.resource_kind,
          resourceKey: row.resource_key,
          resourceUrl: snapshotUrl(current, row.resource_url),
          eventTypes: events.map((event) => event.type),
          routedTo: [agent],
        },
      });
      this.options.onEvent(message, [agent]);
    } catch (error) {
      if (this.pollStillCurrent(id, generation)) {
        const failedAt = this.now().toISOString();
        this.commitPollWrite(
          `UPDATE resource_subscriptions
           SET last_polled_at = ?, last_error = ?, updated_at = ?
           WHERE poll_generation = ? AND active = 1 AND id = ?`,
          [failedAt, errorText(error), failedAt, generation, id],
        );
        throw error;
      }
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

  private pollStillCurrent(id: string, generation: number): boolean {
    const row = this.get(id);
    return Boolean(row && row.active === 1 && row.poll_generation === generation);
  }

  private commitPollWrite(
    sql: string,
    params: Array<string | number | null>,
  ): boolean {
    return this.store.db.query(sql).run(...params).changes === 1;
  }

  private get(id: string): SubscriptionRow | null {
    return this.store.db
      .query<SubscriptionRow, [string]>(
        "SELECT * FROM resource_subscriptions WHERE id = ?",
      )
      .get(id);
  }

  private find(
    threadId: string,
    provider: string,
    resourceKind: string,
    key: string,
  ): SubscriptionRow | null {
    return this.store.db
      .query<SubscriptionRow, [string, string, string, string]>(
        `SELECT * FROM resource_subscriptions
         WHERE thread_id = ? AND provider = ?
           AND resource_kind = ? AND resource_key = ?`,
      )
      .get(threadId, provider, resourceKind, key);
  }

  private async readSnapshotForRef(
    ref: SubscriptionResourceRef,
  ): Promise<ResourceSnapshot> {
    if (ref.provider === "cursor") return this.readCursorAgent(ref.key);
    return this.readPullRequest(ref.url);
  }

  private async readSnapshotForRow(
    row: SubscriptionRow,
  ): Promise<ResourceSnapshot> {
    if (row.provider === "cursor") return this.readCursorAgent(row.resource_key);
    return this.readPullRequest(row.resource_url);
  }

  private async resourceEvents(
    row: Pick<SubscriptionRow, "provider" | "resource_kind" | "resource_key">,
    previous: ResourceSnapshot,
    current: ResourceSnapshot,
  ): Promise<ResourceEvent[]> {
    if (row.provider === "cursor") {
      const prior = previous as CursorCloudAgentSnapshot;
      const latest = current as CursorCloudAgentSnapshot;
      return cursorCloudAgentEvents(
        prior,
        latest,
        await this.listUnseenCursorRuns(row.resource_key, prior, latest),
      );
    }
    return pullRequestEvents(
      previous as PullRequestSnapshot,
      current as PullRequestSnapshot,
    );
  }

  private async listUnseenCursorRuns(
    agentId: string,
    previous: CursorCloudAgentSnapshot,
    current: CursorCloudAgentSnapshot,
  ): Promise<CursorRunSnapshot[]> {
    if (!previous.latestRunId || previous.latestRunId === current.latestRunId) {
      return [];
    }
    const newerNewestFirst: CursorRunSnapshot[] = [];
    let boundary: CursorRunSnapshot | null = null;
    let cursor: string | undefined;
    let seenCurrentLatest = false;
    let morePages = false;
    for (let page = 0; page < CURSOR_RUN_LIST_MAX_PAGES; page += 1) {
      const listed = await this.listCursorRuns(agentId, {
        limit: CURSOR_RUN_LIST_LIMIT,
        cursor,
      });
      for (const item of listed.items) {
        if (!seenCurrentLatest) {
          if (item.id === current.latestRunId || item.id === current.runId) {
            seenCurrentLatest = true;
          }
          continue;
        }
        if (item.id === previous.latestRunId) {
          boundary = item;
          break;
        }
        newerNewestFirst.push(item);
      }
      morePages = Boolean(listed.nextCursor);
      if (boundary || !morePages) break;
      cursor = listed.nextCursor;
    }
    if (!boundary && morePages) {
      throw new Error(
        "Cursor run list did not reach the previously stored run before the page limit; will retry next poll",
      );
    }
    const sequence: CursorRunSnapshot[] = [];
    if (
      boundary &&
      (boundary.status !== previous.runStatus ||
        !CURSOR_TERMINAL_RUN_STATUSES.has(previous.runStatus))
    ) {
      sequence.push(await this.hydrateCursorRun(agentId, boundary, current));
    } else if (
      !boundary &&
      !CURSOR_TERMINAL_RUN_STATUSES.has(previous.runStatus)
    ) {
      sequence.push(await this.readCursorRun(agentId, previous.latestRunId));
    }
    for (const item of newerNewestFirst.reverse()) {
      sequence.push(await this.hydrateCursorRun(agentId, item, current));
    }
    const last = sequence.at(-1);
    if (current.runId && last?.id !== current.runId) {
      sequence.push(cursorRunFromSnapshot(current));
    }
    return sequence;
  }

  private async hydrateCursorRun(
    agentId: string,
    run: CursorRunSnapshot,
    current: CursorCloudAgentSnapshot,
  ): Promise<CursorRunSnapshot> {
    if (run.id === current.runId || run.id === current.latestRunId) {
      return cursorRunFromSnapshot(current);
    }
    return this.readCursorRun(agentId, run.id);
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

export function parseSubscriptionResource(
  resource: string,
): SubscriptionResourceRef {
  const trimmed = resource.trim();
  if (looksLikeCursorCloudAgent(trimmed)) return parseCursorCloudAgent(trimmed);
  try {
    return parseGithubPullRequest(trimmed);
  } catch {
    throw new Error(
      "resource must be a GitHub pull request URL or owner/repo#number, or a Cursor cloud agent ID (bc-…) or https://cursor.com/agents/… URL",
    );
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
    provider: "github",
    resourceKind: "pull_request",
    owner,
    repo,
    number,
    key,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

export function parseCursorCloudAgent(resource: string): CursorCloudAgentRef {
  const trimmed = resource.trim();
  if (CURSOR_AGENT_ID_PATTERN.test(trimmed)) return cursorAgentRef(trimmed);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw cursorResourceError();
  }
  if (
    !/^https?:$/i.test(parsed.protocol) ||
    !/^(?:www\.)?cursor\.com$/i.test(parsed.hostname)
  ) {
    throw cursorResourceError();
  }
  const pathId = parsed.pathname.match(
    /^\/agents\/(bc-[A-Za-z0-9][A-Za-z0-9_-]*)\/?$/,
  );
  if (pathId) return cursorAgentRef(pathId[1]!);
  if (parsed.pathname === "/agents" || parsed.pathname === "/agents/") {
    const id = parsed.searchParams.get("id")?.trim() ?? "";
    if (CURSOR_AGENT_ID_PATTERN.test(id)) return cursorAgentRef(id);
  }
  throw cursorResourceError();
}

export function normalizeSubscriptionEvents(
  resourceKind: SubscriptionResourceKind,
  requested?: readonly string[],
): SubscriptionEventType[] {
  return resourceKind === "cloud_agent"
    ? normalizeCursorCloudAgentEvents(requested)
    : normalizeGithubPullRequestEvents(requested);
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

function cursorApiKeyFromEnv(): string | undefined {
  const value = process.env.CURSOR_API_KEY?.trim();
  return value || undefined;
}

async function defaultReadCursorAgent(
  id: string,
  getApiKey: () => string | undefined,
): Promise<CursorCloudAgentSnapshot> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "CURSOR_API_KEY is not set; cannot read the Cursor cloud agent",
    );
  }
  const agent = await cursorApiGet(`/v1/agents/${encodeURIComponent(id)}`, apiKey);
  const latestRunId = stringValue(agent.latestRunId);
  const run = latestRunId
    ? await cursorApiGet(
        `/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(latestRunId)}`,
        apiKey,
      )
    : {};
  return normalizeCursorCloudAgent(agent, run);
}

async function defaultReadCursorRun(
  agentId: string,
  runId: string,
  getApiKey: () => string | undefined,
): Promise<CursorRunSnapshot> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "CURSOR_API_KEY is not set; cannot read the Cursor cloud agent",
    );
  }
  const run = await cursorApiGet(
    `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    apiKey,
  );
  return normalizeCursorRun(run, runId);
}

function normalizeCursorRun(
  run: Record<string, unknown>,
  fallbackId: string,
): CursorRunSnapshot {
  return {
    id: stringValue(run.id) || fallbackId,
    status: stringValue(run.status),
    result: stringValue(run.result),
  };
}

function cursorRunFromSnapshot(
  snapshot: CursorCloudAgentSnapshot,
): CursorRunSnapshot {
  return {
    id: snapshot.runId || snapshot.latestRunId,
    status: snapshot.runStatus,
    result: snapshot.runResult,
  };
}

async function defaultListCursorRuns(
  agentId: string,
  query: { cursor?: string; limit?: number } | undefined,
  getApiKey: () => string | undefined,
): Promise<CursorRunPage> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "CURSOR_API_KEY is not set; cannot read the Cursor cloud agent",
    );
  }
  const params = new URLSearchParams();
  params.set("limit", String(query?.limit ?? CURSOR_RUN_LIST_LIMIT));
  if (query?.cursor) params.set("cursor", query.cursor);
  const body = await cursorApiGet(
    `/v1/agents/${encodeURIComponent(agentId)}/runs?${params.toString()}`,
    apiKey,
  );
  const nextCursor = stringValue(body.nextCursor);
  return {
    items: arrayValue(body.items).map((item, index) =>
      normalizeCursorRun(recordValue(item), `run-${index}`),
    ),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

async function cursorApiGet(
  path: string,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${CURSOR_API_BASE}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    const detail = body.trim() || response.statusText || `HTTP ${response.status}`;
    throw new Error(`Cursor API could not read the cloud agent: ${detail}`);
  }
  try {
    const value = JSON.parse(body) as unknown;
    return recordValue(value);
  } catch {
    throw new Error("Cursor API returned invalid JSON for the cloud agent");
  }
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

function normalizeCursorCloudAgent(
  agent: Record<string, unknown>,
  run: Record<string, unknown>,
): CursorCloudAgentSnapshot {
  const id = stringValue(agent.id);
  const git = recordValue(run.git);
  return {
    id,
    name: stringValue(agent.name),
    status: stringValue(agent.status),
    url: stringValue(agent.url) || `https://cursor.com/agents/${id}`,
    latestRunId: stringValue(agent.latestRunId),
    runId: stringValue(run.id),
    runStatus: stringValue(run.status),
    runResult: stringValue(run.result),
    branches: arrayValue(git.branches)
      .map((item) => {
        const branch = recordValue(item);
        return {
          repoUrl: stringValue(branch.repoUrl),
          branch: stringValue(branch.branch),
          prUrl: stringValue(branch.prUrl),
        };
      })
      .sort((a, b) =>
        `${a.repoUrl}#${a.branch}`.localeCompare(`${b.repoUrl}#${b.branch}`),
      ),
  };
}

function resourceEventMessage(
  row: Pick<SubscriptionRow, "provider" | "resource_key">,
  current: ResourceSnapshot,
  events: ResourceEvent[],
): string {
  const lines = events.map((event) => `- ${event.summary}`).join("\n");
  if (row.provider === "cursor") {
    const agent = current as CursorCloudAgentSnapshot;
    const label = agent.name || row.resource_key;
    return `Cursor cloud agent event for [${label}](${agent.url}):\n\n${lines}`;
  }
  const pull = current as PullRequestSnapshot;
  return `GitHub PR event for [${row.resource_key}: ${pull.title}](${pull.url}):\n\n${lines}`;
}

function pullRequestEvents(
  previous: PullRequestSnapshot,
  current: PullRequestSnapshot,
): ResourceEvent[] {
  const events: ResourceEvent[] = [];
  addChangedEvent(
    events,
    "github.state_changed",
    "State",
    previous.state,
    current.state,
  );
  addChangedEvent(
    events,
    "github.draft_changed",
    "Draft",
    yesNo(previous.isDraft),
    yesNo(current.isDraft),
  );
  addChangedEvent(
    events,
    "github.review_decision_changed",
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
      type: "github.checks_failed",
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
      type: "github.checks_passed",
      summary: `Checks passed: ${checkSummary(current.checks)}`,
    });
  }

  addIncreaseEvent(
    events,
    "github.new_review",
    "review",
    previous.reviewCount,
    current.reviewCount,
  );
  addIncreaseEvent(
    events,
    "github.new_comment",
    "comment",
    previous.commentCount,
    current.commentCount,
  );
  addIncreaseEvent(
    events,
    "github.new_commit",
    "commit",
    previous.commitCount,
    current.commitCount,
  );
  addChangedEvent(
    events,
    "github.labels_changed",
    "Labels",
    previous.labels.join(", "),
    current.labels.join(", "),
  );
  addChangedEvent(
    events,
    "github.assignees_changed",
    "Assignees",
    previous.assignees.join(", "),
    current.assignees.join(", "),
  );
  addChangedEvent(
    events,
    "github.mergeability_changed",
    "Mergeability",
    mergeabilitySummary(previous),
    mergeabilitySummary(current),
  );
  return events;
}

function cursorCloudAgentEvents(
  previous: CursorCloudAgentSnapshot,
  current: CursorCloudAgentSnapshot,
  unseenOldestFirst: CursorRunSnapshot[],
): ResourceEvent[] {
  const events: ResourceEvent[] = [];
  addChangedEvent(
    events,
    "cursor.status_changed",
    "Status",
    previous.status,
    current.status,
  );
  const sequence =
    unseenOldestFirst.length > 0
      ? unseenOldestFirst
      : [cursorRunFromSnapshot(current)];
  for (const run of sequence) {
    if (run.id && run.id !== previous.latestRunId) {
      events.push({
        type: "cursor.new_run",
        summary: `New run: ${run.id}`,
      });
    }
    if (
      run.id === previous.runId &&
      run.status &&
      run.status !== previous.runStatus
    ) {
      events.push({
        type: "cursor.run_status_changed",
        summary: `Run status: ${display(previous.runStatus)} → ${display(run.status)}`,
      });
    }
    appendCursorRunOutcomeEvents(events, previous, {
      runId: run.id,
      runStatus: run.status,
      runResult: run.result,
    });
  }

  const previousPrs = new Set(
    previous.branches.map((branch) => branch.prUrl).filter(Boolean),
  );
  const openedPrs = current.branches
    .map((branch) => branch.prUrl)
    .filter((url) => url && !previousPrs.has(url));
  if (openedPrs.length > 0) {
    events.push({
      type: "cursor.pr_opened",
      summary: `PR opened: ${openedPrs.join(", ")}`,
    });
  }
  addChangedEvent(
    events,
    "cursor.branch_changed",
    "Branches",
    branchIdentity(previous.branches),
    branchIdentity(current.branches),
  );
  return events;
}

function appendCursorRunOutcomeEvents(
  events: ResourceEvent[],
  previous: CursorCloudAgentSnapshot,
  observed: Pick<
    CursorCloudAgentSnapshot,
    "runId" | "runStatus" | "runResult"
  >,
): void {
  if (reachedRunStatus(previous, observed, "FINISHED")) {
    events.push({
      type: "cursor.run_finished",
      summary: runOutcomeSummary("Run finished", observed),
    });
  }
  if (
    reachedRunStatus(previous, observed, "ERROR") ||
    reachedRunStatus(previous, observed, "EXPIRED")
  ) {
    events.push({
      type: "cursor.run_failed",
      summary: runOutcomeSummary("Run failed", observed),
    });
  }
  if (reachedRunStatus(previous, observed, "CANCELLED")) {
    events.push({
      type: "cursor.run_cancelled",
      summary: runOutcomeSummary("Run cancelled", observed),
    });
  }
}

function reachedRunStatus(
  previous: Pick<CursorCloudAgentSnapshot, "runId" | "runStatus">,
  current: Pick<CursorCloudAgentSnapshot, "runId" | "runStatus">,
  status: string,
): boolean {
  if (current.runStatus !== status) return false;
  return previous.runId !== current.runId || previous.runStatus !== status;
}

function runOutcomeSummary(
  label: string,
  current: Pick<CursorCloudAgentSnapshot, "runId" | "runResult">,
): string {
  return current.runResult
    ? `${label} (${current.runId}): ${current.runResult}`
    : `${label} (${current.runId})`;
}

function branchIdentity(branches: CursorBranchSnapshot[]): string {
  return branches
    .map((branch) => `${branch.repoUrl}#${branch.branch}`)
    .join(", ");
}

function addChangedEvent(
  events: ResourceEvent[],
  type: SubscriptionEventType,
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
  events: ResourceEvent[],
  type: SubscriptionEventType,
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
    provider: row.provider === "cursor" ? "cursor" : "github",
    resourceKind:
      row.resource_kind === "cloud_agent" ? "cloud_agent" : "pull_request",
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
  row: Pick<SubscriptionRow, "provider" | "resource_kind" | "events_json">,
): SubscriptionEventType[] {
  const kind: SubscriptionResourceKind =
    row.provider === "cursor" || row.resource_kind === "cloud_agent"
      ? "cloud_agent"
      : "pull_request";
  try {
    const value = JSON.parse(row.events_json) as unknown;
    const requested = Array.isArray(value)
      ? value.map((event) => coerceStoredEvent(kind, String(event)))
      : undefined;
    return requested
      ? normalizeSubscriptionEvents(kind, requested)
      : normalizeSubscriptionEvents(kind);
  } catch {
    return normalizeSubscriptionEvents(kind);
  }
}

function coerceStoredEvent(
  kind: SubscriptionResourceKind,
  event: string,
): string {
  if (kind !== "pull_request") return event;
  return LEGACY_GITHUB_EVENT_NAMES[event] ?? event;
}

function normalizeGithubPullRequestEvents(
  requested?: readonly string[],
): GithubPullRequestEventType[] {
  return normalizeEventList(
    requested,
    GITHUB_PULL_REQUEST_EVENT_TYPES,
    DEFAULT_GITHUB_PULL_REQUEST_EVENTS,
    "pull request",
  );
}

function normalizeCursorCloudAgentEvents(
  requested?: readonly string[],
): CursorCloudAgentEventType[] {
  return normalizeEventList(
    requested,
    CURSOR_CLOUD_AGENT_EVENT_TYPES,
    DEFAULT_CURSOR_CLOUD_AGENT_EVENTS,
    "cloud agent",
  );
}

function normalizeEventList<T extends string>(
  requested: readonly string[] | undefined,
  supportedList: readonly T[],
  defaults: T[],
  label: string,
): T[] {
  if (requested === undefined) return [...defaults];
  if (requested.length === 0) {
    throw new Error("events must contain at least one event type");
  }
  const supported = new Set<string>(supportedList);
  const unknown = [...new Set(requested)].filter((event) => !supported.has(event));
  if (unknown.length > 0) {
    throw new Error(
      `unsupported ${label} event${unknown.length === 1 ? "" : "s"}: ${unknown.join(
        ", ",
      )}; supported events: ${supportedList.join(", ")}`,
    );
  }
  const selected = new Set(requested);
  return supportedList.filter((event) => selected.has(event));
}

function looksLikeCursorCloudAgent(resource: string): boolean {
  return (
    CURSOR_AGENT_ID_PATTERN.test(resource) ||
    /(?:^|\/\/)(?:www\.)?cursor\.com\b/i.test(resource)
  );
}

function cursorAgentRef(id: string): CursorCloudAgentRef {
  return {
    provider: "cursor",
    resourceKind: "cloud_agent",
    key: id,
    url: `https://cursor.com/agents/${id}`,
  };
}

function cursorResourceError(): Error {
  return new Error(
    "resource must be a Cursor cloud agent ID (bc-…) or https://cursor.com/agents/… URL",
  );
}

function snapshotUrl(snapshot: ResourceSnapshot, fallback: string): string {
  return snapshot.url || fallback;
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
