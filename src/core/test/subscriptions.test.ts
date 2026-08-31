import { expect, test } from "bun:test";
import { SchedulerService } from "@/core/scheduler";
import {
  DEFAULT_GITHUB_PULL_REQUEST_EVENTS,
  GITHUB_PULL_REQUEST_EVENT_TYPES,
  normalizeSubscriptionEvents,
  parseGithubPullRequest,
  SubscriptionService,
} from "@/core/subscriptions";
import { PhiStore } from "@/core/store/store";
import { tempDir } from "@/testing/tmpdir";
import type { Message } from "@/shared/types";

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

function fixture(outputs: string[]) {
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

test("parses GitHub PR URLs and shorthand into one resource key", () => {
  expect(parseGithubPullRequest("https://github.com/OpenAI/Phi/pull/42/files")).toEqual({
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

test("validates and canonicalizes selected PR event types", () => {
  expect(normalizeSubscriptionEvents()).toEqual(
    DEFAULT_GITHUB_PULL_REQUEST_EVENTS,
  );
  expect(
    normalizeSubscriptionEvents(["new_comment", "state_changed", "new_comment"]),
  ).toEqual(["state_changed", "new_comment"]);
  expect(() => normalizeSubscriptionEvents([])).toThrow("at least one");
  expect(() => normalizeSubscriptionEvents(["mystery_event"])).toThrow(
    `supported events: ${GITHUB_PULL_REQUEST_EVENT_TYPES.join(", ")}`,
  );
});

test("captures a gh baseline and makes duplicate subscriptions idempotent", async () => {
  const { store, thread, scheduler, service, ghCalls } = fixture([
    pullRequest(),
  ]);
  const first = await service.subscribe(thread.id, "openai/phi#42", [
    "new_comment",
  ]);
  const duplicate = await service.subscribe(
    thread.id,
    "https://github.com/openai/phi/pull/42",
    ["checks_failed", "state_changed"],
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
    "state_changed",
    "checks_failed",
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
  const { store, thread, scheduler, service, events } = fixture([
    pullRequest(),
    pullRequest({
      state: "MERGED",
      reviewDecision: "APPROVED",
      updatedAt: "2026-08-30T00:01:00Z",
      comments: [{ id: "comment-1" }],
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, "openai/phi#42", [
    "state_changed",
    "review_decision_changed",
    "new_comment",
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
      "state_changed",
      "review_decision_changed",
      "new_comment",
    ],
    routedTo: ["codex"],
  });
  scheduler.close();
  store.close();
});

test("does not emit when a PR snapshot has not changed", async () => {
  const snapshot = pullRequest();
  const { store, thread, scheduler, service, events } = fixture([
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
  const { store, thread, scheduler, service, events } = fixture([
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
  const { store, thread, scheduler, service, events } = fixture([
    pullRequest(),
    pullRequest({
      state: "MERGED",
      comments: [{ id: "comment-1" }],
      updatedAt: "2026-08-30T00:01:00Z",
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, "openai/phi#42", [
    "new_comment",
  ]);
  await service.poll(subscription.id);

  expect(events).toHaveLength(1);
  expect(events[0]!.message.content).toContain("1 new comment (1 total)");
  expect(events[0]!.message.content).not.toContain("State:");
  expect(events[0]!.message.metadata.eventTypes).toEqual(["new_comment"]);
  scheduler.close();
  store.close();
});

test("does not wake the thread agent for only unselected events", async () => {
  const { store, thread, scheduler, service, events } = fixture([
    pullRequest(),
    pullRequest({
      state: "MERGED",
      updatedAt: "2026-08-30T00:01:00Z",
    }),
  ]);
  const { subscription } = await service.subscribe(thread.id, "openai/phi#42", [
    "new_comment",
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
  const { store, thread, scheduler, service, events } = fixture([
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
    "checks_failed",
    "checks_passed",
  ]);
  await service.poll(subscription.id);
  await service.poll(subscription.id);

  expect(events).toHaveLength(2);
  expect(events[0]!.message.metadata.eventTypes).toEqual(["checks_failed"]);
  expect(events[1]!.message.metadata.eventTypes).toEqual(["checks_passed"]);
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
