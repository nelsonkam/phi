import { expect, test } from "bun:test";
import { SchedulerService } from "@/core/scheduler";
import {
  CURSOR_CLOUD_AGENT_EVENT_TYPES,
  DEFAULT_CURSOR_CLOUD_AGENT_EVENTS,
  DEFAULT_GITHUB_PULL_REQUEST_EVENTS,
  GITHUB_PULL_REQUEST_EVENT_TYPES,
  normalizeSubscriptionEvents,
  parseCursorCloudAgent,
  parseGithubPullRequest,
  parseSubscriptionResource,
  SubscriptionService,
  type CursorCloudAgentSnapshot,
  type CursorRunPage,
  type CursorRunSnapshot,
} from "@/core/subscriptions";
import { PhiStore } from "@/core/store/store";
import { tempDir } from "@/testing/tmpdir";
import type { Message } from "@/shared/types";

const AGENT_ID = "bc-00000000-0000-0000-0000-000000000001";

function pullRequest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    url: "https://github.com/openai/phi/pull/42",
    title: "Ship subscriptions",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    baseRefName: "main",
    headRefName: "subscriptions",
    headRefOid: "abc123",
    updatedAt: "2026-08-30T00:00:00Z",
    comments: [],
    reviews: [],
    commits: [{ oid: "abc123" }],
    labels: [{ name: "feature" }],
    assignees: [{ login: "nelsonkam" }],
    statusCheckRollup: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
    ...overrides,
  });
}

function cursorAgent(
  overrides: Partial<CursorCloudAgentSnapshot> = {},
): CursorCloudAgentSnapshot {
  return {
    id: AGENT_ID,
    name: "Add README",
    status: "ACTIVE",
    url: `https://cursor.com/agents/${AGENT_ID}`,
    latestRunId: "run-1",
    runId: "run-1",
    runStatus: "RUNNING",
    runResult: "",
    branches: [],
    ...overrides,
  };
}

function githubFixture(outputs: string[]) {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Watch this PR",
    metadata: { routedTo: ["codex"] },
  });
  const scheduler = new SchedulerService(store);
  const ghCalls: string[][] = [];
  const events: Array<{ message: Message; routedTo: string[] }> = [];
  let index = 0;
  const service = new SubscriptionService(store, scheduler, {
    pollIntervalMs: 30_000,
    threadAgent: async () => "codex",
    onEvent: (message, routedTo) => events.push({ message, routedTo }),
    runGh: async (args) => {
      ghCalls.push(args);
      return outputs[Math.min(index++, outputs.length - 1)]!;
    },
  });
  return { store, thread, scheduler, service, ghCalls, events };
}

function cursorRun(
  id: string,
  status: string,
  result = "",
): CursorRunSnapshot {
  return { id, status, result };
}

function cursorFixture(
  outputs: CursorCloudAgentSnapshot[],
  options: {
    runs?: Record<string, CursorRunSnapshot>;
    listPages?: CursorRunPage[];
  } = {},
) {
  const runs = options.runs ?? {};
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Watch this cloud agent",
    metadata: { routedTo: ["codex"] },
  });
  const scheduler = new SchedulerService(store);
  const agentCalls: string[] = [];
  const runCalls: Array<[string, string]> = [];
  const listCalls: Array<{ cursor?: string; limit?: number }> = [];
  const events: Array<{ message: Message; routedTo: string[] }> = [];
  let index = 0;
  let listPage = 0;
  const service = new SubscriptionService(store, scheduler, {
    pollIntervalMs: 30_000,
    threadAgent: async () => "codex",
    onEvent: (message, routedTo) => events.push({ message, routedTo }),
    readCursorAgent: async (id) => {
      agentCalls.push(id);
      return outputs[Math.min(index++, outputs.length - 1)]!;
    },
    readCursorRun: async (agentId, runId) => {
      runCalls.push([agentId, runId]);
      if (runs[runId]) return runs[runId];
      const match = outputs.find((snapshot) => snapshot.runId === runId);
      if (!match) throw new Error(`missing cursor run ${runId}`);
      return cursorRun(match.runId, match.runStatus, match.runResult);
    },
    listCursorRuns: async (_agentId, query) => {
      listCalls.push(query ?? {});
      if (options.listPages) {
        const page = options.listPages[listPage] ?? { items: [] };
        listPage += 1;
        return page;
      }
      const current = outputs[Math.min(Math.max(index - 1, 0), outputs.length - 1)]!;
      const baseline = outputs[0]!;
      const items = [
        cursorRun(
          current.runId || current.latestRunId,
          current.runStatus,
          current.runResult,
        ),
      ];
      const baselineId = baseline.runId || baseline.latestRunId;
      if (baselineId && baselineId !== items[0]!.id) {
        items.push(
          runs[baselineId] ??
            cursorRun(baselineId, baseline.runStatus, baseline.runResult),
        );
      }
      return { items };
    },
  });
  return {
    store,
    thread,
    scheduler,
    service,
    agentCalls,
    runCalls,
    listCalls,
    events,
  };
}

test("parses GitHub PR URLs and shorthand into one resource key", () => {
  expect(parseGithubPullRequest("https://github.com/OpenAI/Phi/pull/42/files")).toEqual({
    provider: "github",
    resourceKind: "pull_request",
    owner: "OpenAI",
    repo: "Phi",
    number: 42,
    key: "openai/phi#42",
    url: "https://github.com/OpenAI/Phi/pull/42",
  });
  expect(parseGithubPullRequest("openai/phi#42").key).toBe("openai/phi#42");
  expect(() => parseGithubPullRequest("openai/phi/extra#42")).toThrow(
    "GitHub pull request",
  );
  expect(() => parseGithubPullRequest("https://example.com/42")).toThrow(
    "GitHub pull request",
  );
});

test("parses Cursor cloud agent IDs and URLs", () => {
  expect(parseCursorCloudAgent(AGENT_ID)).toEqual({
    provider: "cursor",
    resourceKind: "cloud_agent",
    key: AGENT_ID,
    url: `https://cursor.com/agents/${AGENT_ID}`,
  });
  expect(
    parseCursorCloudAgent(`https://cursor.com/agents/${AGENT_ID}?tab=setup`).key,
  ).toBe(AGENT_ID);
  expect(
    parseCursorCloudAgent(`https://www.cursor.com/agents?id=${AGENT_ID}`).key,
  ).toBe(AGENT_ID);
  expect(() => parseCursorCloudAgent("openai/phi#42")).toThrow("Cursor cloud agent");
  expect(() => parseCursorCloudAgent("https://cursor.com/agents")).toThrow(
    "Cursor cloud agent",
  );
});

test("selects a GitHub or Cursor resource from the subscribe string", () => {
  expect(parseSubscriptionResource("openai/phi#42").provider).toBe("github");
  expect(parseSubscriptionResource(AGENT_ID).provider).toBe("cursor");
  expect(
    parseSubscriptionResource(`https://cursor.com/agents/${AGENT_ID}`).resourceKind,
  ).toBe("cloud_agent");
  expect(() => parseSubscriptionResource("not-a-resource")).toThrow(
    "GitHub pull request URL or owner/repo#number, or a Cursor cloud agent",
  );
});

test("validates and canonicalizes selected event types per resource kind", () => {
  expect(normalizeSubscriptionEvents("pull_request")).toEqual(
    DEFAULT_GITHUB_PULL_REQUEST_EVENTS,
  );
  expect(
    normalizeSubscriptionEvents("pull_request", [
      "github.new_comment",
      "github.state_changed",
      "github.new_comment",
    ]),
  ).toEqual(["github.state_changed", "github.new_comment"]);
  expect(normalizeSubscriptionEvents("cloud_agent")).toEqual(
    DEFAULT_CURSOR_CLOUD_AGENT_EVENTS,
  );
  expect(() => normalizeSubscriptionEvents("pull_request", [])).toThrow(
    "at least one",
  );
  expect(() =>
    normalizeSubscriptionEvents("pull_request", ["state_changed"]),
  ).toThrow(`supported events: ${GITHUB_PULL_REQUEST_EVENT_TYPES.join(", ")}`);
  expect(() =>
    normalizeSubscriptionEvents("pull_request", ["cursor.run_finished"]),
  ).toThrow("unsupported pull request event");
  expect(() =>
    normalizeSubscriptionEvents("cloud_agent", ["github.state_changed"]),
  ).toThrow(
    `supported events: ${CURSOR_CLOUD_AGENT_EVENT_TYPES.join(", ")}`,
  );
});

test("captures a gh baseline and makes duplicate subscriptions idempotent", async () => {
  const { store, thread, scheduler, service, ghCalls } = githubFixture([
    pullRequest(),
  ]);
  const first = await service.subscribe(thread.id, "openai/phi#42", [
    "github.new_comment",
  ]);
  const duplicate = await service.subscribe(
    thread.id,
    "https://github.com/openai/phi/pull/42",
    ["github.checks_failed", "github.state_changed"],
  );

  expect(first.created).toBe(true);
  expect(first.subscription).toMatchObject({
    threadId: thread.id,
    provider: "github",
    resourceKind: "pull_request",
    resourceKey: "openai/phi#42",
  });
  expect(duplicate.created).toBe(false);
  expect(duplicate.subscription.id).toBe(first.subscription.id);
  expect(duplicate.subscription.events).toEqual([
    "github.state_changed",
    "github.checks_failed",
  ]);
  expect(ghCalls).toHaveLength(1);
  expect(ghCalls[0]!.slice(0, 3)).toEqual([
    "pr",
    "view",
    "https://github.com/openai/phi/pull/42",
  ]);
  expect(scheduler.getTask(`subscription.${first.subscription.id}`)).toMatchObject({
    handler: "resource-subscription",
    schedule: { kind: "interval", everyMs: 30_000 },
  });
  scheduler.close();
  store.close();
});

test("posts changed PR state to the thread and wakes its agent", async () => {
  const { store, thread, scheduler, service, events } = githubFixture([
    pullRequest(),
    pullRequest({
      state: "MERGED",
      reviewDecision: "APPROVED",
      updatedAt: "2026-08-30T00:01:00Z",
      comments: [{ id: "comment-1" }],
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, "openai/phi#42", [
    "github.state_changed",
    "github.review_decision_changed",
    "github.new_comment",
  ]);
  await service.poll(subscription.id);

  expect(events).toHaveLength(1);
  expect(events[0]!.routedTo).toEqual(["codex"]);
  expect(events[0]!.message).toMatchObject({
    threadId: thread.id,
    author: "system",
    kind: "resource_event",
  });
  expect(events[0]!.message.content).toContain("State: OPEN → MERGED");
  expect(events[0]!.message.content).toContain(
    "Review decision: none → APPROVED",
  );
  expect(events[0]!.message.content).toContain("1 new comment (1 total)");
  expect(events[0]!.message.metadata).toMatchObject({
    subscriptionId: subscription.id,
    eventTypes: [
      "github.state_changed",
      "github.review_decision_changed",
      "github.new_comment",
    ],
    routedTo: ["codex"],
  });
  scheduler.close();
  store.close();
});

test("does not emit when a PR snapshot has not changed", async () => {
  const snapshot = pullRequest();
  const { store, thread, scheduler, service, events } = githubFixture([
    snapshot,
    snapshot,
  ]);
  const { subscription } = await service.subscribe(thread.id, "openai/phi#42");
  await service.poll(subscription.id);
  expect(events).toEqual([]);
  expect(store.listMessages(thread.id)).toHaveLength(1);
  scheduler.close();
  store.close();
});

test("persists snapshot-only changes without waking the thread agent", async () => {
  const { store, thread, scheduler, service, events } = githubFixture([
    pullRequest({
      updatedAt: "2026-08-30T00:00:00Z",
      statusCheckRollup: [
        { name: "test", status: "QUEUED", conclusion: "" },
      ],
    }),
    pullRequest({
      updatedAt: "2026-08-30T00:01:00Z",
      statusCheckRollup: [
        { name: "test", status: "IN_PROGRESS", conclusion: "" },
      ],
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, "openai/phi#42");
  await service.poll(subscription.id);

  expect(events).toEqual([]);
  expect(store.listMessages(thread.id)).toHaveLength(1);
  const row = store.db
    .query<{ state_json: string; last_event_at: string | null }, [string]>(
      "SELECT state_json, last_event_at FROM resource_subscriptions WHERE id = ?",
    )
    .get(subscription.id)!;
  expect(JSON.parse(row.state_json)).toMatchObject({
    updatedAt: "2026-08-30T00:01:00Z",
    checks: [{ name: "test", status: "IN_PROGRESS", conclusion: "" }],
  });
  expect(row.last_event_at).toBeNull();
  scheduler.close();
  store.close();
});

test("filters unselected PR events while batching selected ones", async () => {
  const { store, thread, scheduler, service, events } = githubFixture([
    pullRequest(),
    pullRequest({
      state: "MERGED",
      comments: [{ id: "comment-1" }],
      updatedAt: "2026-08-30T00:01:00Z",
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, "openai/phi#42", [
    "github.new_comment",
  ]);
  await service.poll(subscription.id);

  expect(events).toHaveLength(1);
  expect(events[0]!.message.content).toContain("1 new comment (1 total)");
  expect(events[0]!.message.content).not.toContain("State:");
  expect(events[0]!.message.metadata.eventTypes).toEqual(["github.new_comment"]);
  scheduler.close();
  store.close();
});

test("does not wake the thread agent for only unselected events", async () => {
  const { store, thread, scheduler, service, events } = githubFixture([
    pullRequest(),
    pullRequest({
      state: "MERGED",
      updatedAt: "2026-08-30T00:01:00Z",
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, "openai/phi#42", [
    "github.new_comment",
  ]);
  await service.poll(subscription.id);

  expect(events).toEqual([]);
  expect(store.listMessages(thread.id)).toHaveLength(1);
  const row = store.db
    .query<{ state_json: string; last_event_at: string | null }, [string]>(
      "SELECT state_json, last_event_at FROM resource_subscriptions WHERE id = ?",
    )
    .get(subscription.id)!;
  expect(JSON.parse(row.state_json).state).toBe("MERGED");
  expect(row.last_event_at).toBeNull();
  scheduler.close();
  store.close();
});

test("emits checks_failed and checks_passed only on rollup transitions", async () => {
  const { store, thread, scheduler, service, events } = githubFixture([
    pullRequest({
      statusCheckRollup: [
        { name: "test", status: "IN_PROGRESS", conclusion: "" },
      ],
    }),
    pullRequest({
      statusCheckRollup: [
        { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
      ],
    }),
    pullRequest({
      statusCheckRollup: [
        { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, "openai/phi#42", [
    "github.checks_failed",
    "github.checks_passed",
  ]);
  await service.poll(subscription.id);
  await service.poll(subscription.id);

  expect(events).toHaveLength(2);
  expect(events[0]!.message.metadata.eventTypes).toEqual(["github.checks_failed"]);
  expect(events[1]!.message.metadata.eventTypes).toEqual(["github.checks_passed"]);
  scheduler.close();
  store.close();
});

test("maps legacy unprefixed GitHub event names on stored rows", async () => {
  const { store, thread, scheduler, service, events } = githubFixture([
    pullRequest(),
    pullRequest({
      state: "MERGED",
      updatedAt: "2026-08-30T00:01:00Z",
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, "openai/phi#42", [
    "github.state_changed",
  ]);
  store.db
    .query("UPDATE resource_subscriptions SET events_json = ? WHERE id = ?")
    .run(JSON.stringify(["state_changed"]), subscription.id);
  await service.poll(subscription.id);

  expect(events).toHaveLength(1);
  expect(events[0]!.message.metadata.eventTypes).toEqual(["github.state_changed"]);
  scheduler.close();
  store.close();
});

test("restores persisted subscription tasks after restart", async () => {
  const root = tempDir();
  let now = new Date("2026-08-30T00:00:00.000Z");
  const firstStore = new PhiStore(root);
  const workspace = firstStore.defaultWorkspace();
  const channel = firstStore.listChannels(workspace.id)[0]!;
  const { thread } = firstStore.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Watch this PR",
  });
  const firstScheduler = new SchedulerService(firstStore, () => now);
  const firstService = new SubscriptionService(firstStore, firstScheduler, {
    now: () => now,
    threadAgent: async () => "codex",
    onEvent: () => undefined,
    runGh: async () => pullRequest(),
  });
  const { subscription } = await firstService.subscribe(
    thread.id,
    "openai/phi#42",
  );
  firstScheduler.close();
  firstStore.close();

  now = new Date("2026-08-30T00:02:00.000Z");
  const reopened = new PhiStore(root);
  const resumedScheduler = new SchedulerService(reopened, () => now);
  const events: Message[] = [];
  new SubscriptionService(reopened, resumedScheduler, {
    now: () => now,
    threadAgent: async () => "codex",
    onEvent: (message) => events.push(message),
    runGh: async () =>
      pullRequest({
        state: "MERGED",
        updatedAt: "2026-08-30T00:02:00Z",
      }),
  });
  expect(resumedScheduler.getTask(`subscription.${subscription.id}`)).not.toBeNull();
  expect(await resumedScheduler.runDue(now)).toBe(1);
  expect(events).toHaveLength(1);
  expect(events[0]!.content).toContain("State: OPEN → MERGED");
  resumedScheduler.close();
  reopened.close();
});

test("captures a Cursor baseline and lets a thread watch a PR and an agent", async () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Watch both",
  });
  const scheduler = new SchedulerService(store);
  const service = new SubscriptionService(store, scheduler, {
    threadAgent: async () => "codex",
    onEvent: () => undefined,
    runGh: async () => pullRequest(),
    readCursorAgent: async () => cursorAgent(),
  });
  const pr = await service.subscribe(thread.id, "openai/phi#42");
  const agent = await service.subscribe(thread.id, AGENT_ID, [
    "cursor.run_finished",
  ]);
  const duplicate = await service.subscribe(
    thread.id,
    `https://cursor.com/agents/${AGENT_ID}`,
    ["cursor.status_changed", "cursor.pr_opened"],
  );

  expect(pr.subscription.provider).toBe("github");
  expect(agent.created).toBe(true);
  expect(agent.subscription).toMatchObject({
    provider: "cursor",
    resourceKind: "cloud_agent",
    resourceKey: AGENT_ID,
  });
  expect(duplicate.created).toBe(false);
  expect(duplicate.subscription.id).toBe(agent.subscription.id);
  expect(duplicate.subscription.events).toEqual([
    "cursor.status_changed",
    "cursor.pr_opened",
  ]);
  expect(pr.subscription.id).not.toBe(agent.subscription.id);
  scheduler.close();
  store.close();
});

test("posts Cursor run and PR events and wakes the thread agent", async () => {
  const { store, thread, scheduler, service, events, agentCalls } = cursorFixture([
    cursorAgent(),
    cursorAgent({
      status: "IDLE",
      latestRunId: "run-2",
      runId: "run-2",
      runStatus: "FINISHED",
      runResult: "Added README.md",
      branches: [
        {
          repoUrl: "github.com/openai/phi",
          branch: "cursor/add-readme",
          prUrl: "https://github.com/openai/phi/pull/99",
        },
      ],
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, AGENT_ID, [
    "cursor.status_changed",
    "cursor.new_run",
    "cursor.run_finished",
    "cursor.pr_opened",
  ]);
  await service.poll(subscription.id);

  expect(agentCalls).toEqual([AGENT_ID, AGENT_ID]);
  expect(events).toHaveLength(1);
  expect(events[0]!.message.content).toContain("Status: ACTIVE → IDLE");
  expect(events[0]!.message.content).toContain("New run: run-2");
  expect(events[0]!.message.content).toContain("Run finished (run-2): Added README.md");
  expect(events[0]!.message.content).toContain(
    "PR opened: https://github.com/openai/phi/pull/99",
  );
  expect(events[0]!.message.metadata).toMatchObject({
    provider: "cursor",
    resourceKind: "cloud_agent",
    eventTypes: [
      "cursor.status_changed",
      "cursor.new_run",
      "cursor.run_finished",
      "cursor.pr_opened",
    ],
  });
  scheduler.close();
  store.close();
});

test("emits run_finished when a new run completes after a previous finished run", async () => {
  const { store, thread, scheduler, service, events } = cursorFixture([
    cursorAgent({
      status: "IDLE",
      latestRunId: "run-1",
      runId: "run-1",
      runStatus: "FINISHED",
      runResult: "First pass",
    }),
    cursorAgent({
      status: "IDLE",
      latestRunId: "run-2",
      runId: "run-2",
      runStatus: "FINISHED",
      runResult: "Second pass",
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, AGENT_ID, [
    "cursor.run_finished",
  ]);
  await service.poll(subscription.id);

  expect(events).toHaveLength(1);
  expect(events[0]!.message.content).toContain("Run finished (run-2): Second pass");
  scheduler.close();
  store.close();
});

test("does not wake for unselected Cursor events", async () => {
  const { store, thread, scheduler, service, events } = cursorFixture([
    cursorAgent(),
    cursorAgent({
      status: "IDLE",
      runStatus: "FINISHED",
      runResult: "Added README.md",
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, AGENT_ID, [
    "cursor.pr_opened",
  ]);
  await service.poll(subscription.id);

  expect(events).toEqual([]);
  const row = store.db
    .query<{ state_json: string; last_event_at: string | null }, [string]>(
      "SELECT state_json, last_event_at FROM resource_subscriptions WHERE id = ?",
    )
    .get(subscription.id)!;
  expect(JSON.parse(row.state_json).status).toBe("IDLE");
  expect(row.last_event_at).toBeNull();
  scheduler.close();
  store.close();
});

test("emits a superseded run's terminal event when a follow-up becomes latest", async () => {
  const { store, thread, scheduler, service, events, runCalls } = cursorFixture(
    [
      cursorAgent({
        latestRunId: "run-1",
        runId: "run-1",
        runStatus: "RUNNING",
      }),
      cursorAgent({
        latestRunId: "run-2",
        runId: "run-2",
        runStatus: "CREATING",
      }),
    ],
    {
      runs: {
        "run-1": cursorRun("run-1", "FINISHED", "Added README.md"),
      },
    },
  );
  const { subscription } = await service.subscribe(thread.id, AGENT_ID, [
    "cursor.new_run",
    "cursor.run_finished",
  ]);
  await service.poll(subscription.id);

  expect(runCalls).toEqual([[AGENT_ID, "run-1"]]);
  expect(events).toHaveLength(1);
  expect(events[0]!.message.content).toContain(
    "Run finished (run-1): Added README.md",
  );
  expect(events[0]!.message.content).toContain("New run: run-2");
  expect(events[0]!.message.metadata.eventTypes).toEqual([
    "cursor.run_finished",
    "cursor.new_run",
  ]);
  scheduler.close();
  store.close();
});

test("does not emit run_status_changed when only the run id changed", async () => {
  const { store, thread, scheduler, service, events, runCalls } = cursorFixture([
    cursorAgent({
      status: "IDLE",
      latestRunId: "run-1",
      runId: "run-1",
      runStatus: "FINISHED",
      runResult: "First pass",
    }),
    cursorAgent({
      status: "IDLE",
      latestRunId: "run-2",
      runId: "run-2",
      runStatus: "FINISHED",
      runResult: "Second pass",
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, AGENT_ID, [
    "cursor.run_status_changed",
  ]);
  await service.poll(subscription.id);

  expect(runCalls).toEqual([]);
  expect(events).toEqual([]);
  scheduler.close();
  store.close();
});

test("does not emit run_status_changed across different runs with different statuses", async () => {
  const { store, thread, scheduler, service, events } = cursorFixture([
    cursorAgent({
      status: "IDLE",
      latestRunId: "run-1",
      runId: "run-1",
      runStatus: "FINISHED",
      runResult: "First pass",
    }),
    cursorAgent({
      latestRunId: "run-2",
      runId: "run-2",
      runStatus: "CREATING",
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, AGENT_ID, [
    "cursor.run_status_changed",
  ]);
  await service.poll(subscription.id);

  expect(events).toEqual([]);
  scheduler.close();
  store.close();
});

test("emits outcomes for intermediate runs found by paging until the stored latest", async () => {
  const { store, thread, scheduler, service, events, runCalls, listCalls } =
    cursorFixture(
      [
        cursorAgent({
          latestRunId: "run-1",
          runId: "run-1",
          runStatus: "RUNNING",
        }),
        cursorAgent({
          status: "IDLE",
          latestRunId: "run-3",
          runId: "run-3",
          runStatus: "FINISHED",
          runResult: "Third pass",
        }),
      ],
      {
        runs: {
          "run-1": cursorRun("run-1", "FINISHED", "First pass"),
          "run-2": cursorRun("run-2", "FINISHED", "Second pass"),
        },
        listPages: [
          {
            items: [
              cursorRun("run-3", "FINISHED"),
              cursorRun("run-2", "FINISHED"),
            ],
            nextCursor: "page-2",
          },
          {
            items: [cursorRun("run-1", "FINISHED")],
          },
        ],
      },
    );
  const { subscription } = await service.subscribe(thread.id, AGENT_ID, [
    "cursor.new_run",
    "cursor.run_finished",
  ]);
  await service.poll(subscription.id);

  expect(listCalls).toEqual([
    { limit: 100, cursor: undefined },
    { limit: 100, cursor: "page-2" },
  ]);
  expect(runCalls).toEqual([
    [AGENT_ID, "run-1"],
    [AGENT_ID, "run-2"],
  ]);
  expect(events).toHaveLength(1);
  expect(events[0]!.message.content).toContain("Run finished (run-1): First pass");
  expect(events[0]!.message.content).toContain("New run: run-2");
  expect(events[0]!.message.content).toContain("Run finished (run-2): Second pass");
  expect(events[0]!.message.content).toContain("New run: run-3");
  expect(events[0]!.message.content).toContain("Run finished (run-3): Third pass");
  expect(events[0]!.message.metadata.eventTypes).toEqual([
    "cursor.run_finished",
    "cursor.new_run",
    "cursor.run_finished",
    "cursor.new_run",
    "cursor.run_finished",
  ]);
  scheduler.close();
  store.close();
});

test("ignores list runs newer than the snapshot latest", async () => {
  const { store, thread, scheduler, service, events, runCalls } = cursorFixture(
    [
      cursorAgent({
        latestRunId: "run-1",
        runId: "run-1",
        runStatus: "RUNNING",
      }),
      cursorAgent({
        status: "IDLE",
        latestRunId: "run-3",
        runId: "run-3",
        runStatus: "FINISHED",
        runResult: "Third pass",
      }),
    ],
    {
      runs: {
        "run-1": cursorRun("run-1", "FINISHED", "First pass"),
        "run-2": cursorRun("run-2", "FINISHED", "Second pass"),
        "run-4": cursorRun("run-4", "CREATING"),
      },
      listPages: [
        {
          items: [
            cursorRun("run-4", "CREATING"),
            cursorRun("run-3", "FINISHED"),
            cursorRun("run-2", "FINISHED"),
            cursorRun("run-1", "FINISHED"),
          ],
        },
      ],
    },
  );
  const { subscription } = await service.subscribe(thread.id, AGENT_ID, [
    "cursor.new_run",
    "cursor.run_finished",
  ]);
  await service.poll(subscription.id);

  expect(runCalls).toEqual([
    [AGENT_ID, "run-1"],
    [AGENT_ID, "run-2"],
  ]);
  expect(events[0]!.message.content).toContain("Run finished (run-1): First pass");
  expect(events[0]!.message.content).toContain("New run: run-2");
  expect(events[0]!.message.content).toContain("Run finished (run-2): Second pass");
  expect(events[0]!.message.content).toContain("New run: run-3");
  expect(events[0]!.message.content).toContain("Run finished (run-3): Third pass");
  expect(events[0]!.message.content).not.toContain("run-4");
  expect(events[0]!.message.metadata.eventTypes).toEqual([
    "cursor.run_finished",
    "cursor.new_run",
    "cursor.run_finished",
    "cursor.new_run",
    "cursor.run_finished",
  ]);
  scheduler.close();
  store.close();
});

test("does not advance the snapshot when run listing is truncated", async () => {
  const { store, thread, scheduler, service, events } = cursorFixture(
    [
      cursorAgent({
        latestRunId: "run-1",
        runId: "run-1",
        runStatus: "RUNNING",
      }),
      cursorAgent({
        latestRunId: "run-3",
        runId: "run-3",
        runStatus: "FINISHED",
        runResult: "Third pass",
      }),
    ],
    {
      listPages: Array.from({ length: 100 }, () => ({
        items: [
          cursorRun("run-3", "FINISHED"),
          cursorRun("run-2", "FINISHED"),
        ],
        nextCursor: "more",
      })),
    },
  );
  const { subscription } = await service.subscribe(thread.id, AGENT_ID, [
    "cursor.run_finished",
  ]);
  await expect(service.poll(subscription.id)).rejects.toThrow(
    "previously stored run",
  );
  expect(events).toEqual([]);
  const row = store.db
    .query<{ state_json: string; last_error: string | null }, [string]>(
      "SELECT state_json, last_error FROM resource_subscriptions WHERE id = ?",
    )
    .get(subscription.id)!;
  expect(JSON.parse(row.state_json).latestRunId).toBe("run-1");
  expect(row.last_error).toContain("previously stored run");
  scheduler.close();
  store.close();
});

test("rejects the wrong event family for the resource", async () => {
  const { store, thread, scheduler, service } = githubFixture([pullRequest()]);
  await expect(
    service.subscribe(thread.id, "openai/phi#42", ["cursor.run_finished"]),
  ).rejects.toThrow("unsupported pull request event");
  await expect(
    service.subscribe(thread.id, AGENT_ID, ["github.state_changed"]),
  ).rejects.toThrow("unsupported cloud agent event");
  scheduler.close();
  store.close();
});

test("requires CURSOR_API_KEY when no Cursor reader is injected", async () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Watch this cloud agent",
  });
  const scheduler = new SchedulerService(store);
  const service = new SubscriptionService(store, scheduler, {
    threadAgent: async () => "codex",
    onEvent: () => undefined,
    getCursorApiKey: () => undefined,
  });
  await expect(service.subscribe(thread.id, AGENT_ID)).rejects.toThrow(
    "CURSOR_API_KEY is not set",
  );
  scheduler.close();
  store.close();
});
