import { expect, test } from "bun:test";
import type { ActivityItem, Message } from "@/shared/types";
import {
  ACTIVITY_PAGE_SIZE,
  activityNextCursor,
  latestCommittedMessageId,
} from "@/web/lib/activity";

function message(overrides: Partial<Message>): Message {
  return {
    id: "msg_1",
    workspaceId: "ws",
    channelId: "ch",
    threadId: "th",
    author: "agent",
    kind: "message",
    content: "hi",
    metadata: {},
    seq: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function item(seq: number): ActivityItem {
  return {
    thread: {
      id: `th_${seq}`,
      workspaceId: "ws",
      channelId: "ch",
      title: null,
      status: "open",
      lastSeq: seq,
      turnActive: false,
      turnAgent: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    },
    channelName: "general",
    latestMessage: message({ id: `msg_${seq}`, seq }),
    unreadCount: 0,
  };
}

test("activityNextCursor pages only after a full page", () => {
  const full = Array.from({ length: ACTIVITY_PAGE_SIZE }, (_, i) =>
    item(200 - i),
  );
  expect(activityNextCursor({ activity: full })).toBe(
    full.at(-1)!.latestMessage.seq,
  );
  expect(activityNextCursor({ activity: full.slice(0, 3) })).toBeUndefined();
  expect(activityNextCursor({ activity: [] })).toBeUndefined();
});

test("latestCommittedMessageId skips optimistic rows and tracks commits across equal seqs", () => {
  const committed = message({ id: "msg_a", seq: 4 });
  const optimistic = message({
    id: "optimistic-1",
    seq: 5,
    metadata: { optimistic: true },
  });
  expect(latestCommittedMessageId([committed, optimistic])).toBe("msg_a");
  expect(latestCommittedMessageId([optimistic])).toBeUndefined();
  expect(latestCommittedMessageId([])).toBeUndefined();

  // The committed row can land on the seq the optimistic row predicted; the
  // id still changes, which is what the read-watermark effect keys on.
  const landed = message({ id: "msg_b", seq: 5 });
  expect(latestCommittedMessageId([committed, landed])).toBe("msg_b");
});
