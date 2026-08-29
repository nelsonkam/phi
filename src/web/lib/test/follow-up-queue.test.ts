import { expect, test } from "bun:test";
import { isAttachmentId } from "@/shared/attachments";
import {
  attachmentsToDraft,
  followUpComposerCommit,
  followUpDumpInput,
  followUpSendInput,
  readFollowUpQueue,
  retainedEditingId,
  saveFollowUpQueue,
} from "@/web/lib/follow-up-queue";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

const ATT_ID = `att_${"a".repeat(32)}`;

test("round-trips queued follow-ups per key", () => {
  const storage = fakeStorage();
  saveFollowUpQueue(
    "thread:t1",
    [
      {
        id: "fu_1",
        content: "check the focus bug",
        attachments: [],
      },
      {
        id: "fu_2",
        content: "then retitle the PR",
        attachments: [
          {
            id: ATT_ID,
            filename: "diff.png",
            contentType: "image/png",
            byteSize: 12,
          },
        ],
      },
    ],
    storage,
  );
  expect(readFollowUpQueue("thread:t1", storage)).toEqual([
    { id: "fu_1", content: "check the focus bug", attachments: [] },
    {
      id: "fu_2",
      content: "then retitle the PR",
      attachments: [
        {
          id: ATT_ID,
          filename: "diff.png",
          contentType: "image/png",
          byteSize: 12,
        },
      ],
    },
  ]);
  expect(readFollowUpQueue("thread:t2", storage)).toEqual([]);
});

test("saving an empty queue removes the stored entry", () => {
  const storage = fakeStorage();
  saveFollowUpQueue(
    "thread:t1",
    [{ id: "fu_1", content: "later", attachments: [] }],
    storage,
  );
  saveFollowUpQueue("thread:t1", [], storage);
  expect(readFollowUpQueue("thread:t1", storage)).toEqual([]);
  expect(storage.length).toBe(0);
});

test("swallows storage errors and bad payloads", () => {
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  } as unknown as Storage;
  expect(() =>
    saveFollowUpQueue("k", [{ id: "fu_1", content: "x", attachments: [] }], throwing),
  ).not.toThrow();
  expect(readFollowUpQueue("k", throwing)).toEqual([]);

  const storage = fakeStorage();
  storage.setItem("phi:followup:k", "not-json");
  expect(readFollowUpQueue("k", storage)).toEqual([]);
  storage.setItem("phi:followup:k", JSON.stringify({ v: 2, items: [] }));
  expect(readFollowUpQueue("k", storage)).toEqual([]);
});

test("followUpSendInput copies attachment ids for the send payload", () => {
  expect(isAttachmentId(ATT_ID)).toBe(true);
  expect(
    followUpSendInput({
      id: "fu_1",
      content: "see shot",
      attachments: [
        {
          id: ATT_ID,
          filename: "shot.png",
          contentType: "image/png",
          byteSize: 4,
        },
      ],
    }),
  ).toEqual({
    content: "see shot",
    attachmentIds: [ATT_ID],
    attachments: [
      {
        id: ATT_ID,
        filename: "shot.png",
        contentType: "image/png",
        byteSize: 4,
        createdAt: "",
      },
    ],
  });
});

test("followUpDumpInput joins queued follow-ups into one send", () => {
  const second = `att_${"b".repeat(32)}`;
  expect(
    followUpDumpInput([
      { id: "fu_1", content: "  check focus  ", attachments: [] },
      {
        id: "fu_2",
        content: "then retitle",
        attachments: [
          {
            id: ATT_ID,
            filename: "a.png",
            contentType: "image/png",
            byteSize: 1,
          },
        ],
      },
      {
        id: "fu_3",
        content: "",
        attachments: [
          {
            id: ATT_ID,
            filename: "a.png",
            contentType: "image/png",
            byteSize: 1,
          },
          {
            id: second,
            filename: "b.txt",
            contentType: "text/plain",
            byteSize: 2,
          },
        ],
      },
    ]),
  ).toEqual({
    content: "check focus\n\nthen retitle",
    attachmentIds: [ATT_ID, second],
    attachments: [
      {
        id: ATT_ID,
        filename: "a.png",
        contentType: "image/png",
        byteSize: 1,
        createdAt: "",
      },
      {
        id: second,
        filename: "b.txt",
        contentType: "text/plain",
        byteSize: 2,
        createdAt: "",
      },
    ],
  });
});

test("attachmentsToDraft drops ids the server would reject", () => {
  expect(
    attachmentsToDraft([
      {
        id: ATT_ID,
        filename: "ok.txt",
        contentType: "text/plain",
        byteSize: 1,
        createdAt: "",
      },
      {
        id: "not-an-id",
        filename: "skip.txt",
        contentType: "text/plain",
        byteSize: 1,
        createdAt: "",
      },
    ]),
  ).toEqual([
    {
      id: ATT_ID,
      filename: "ok.txt",
      contentType: "text/plain",
      byteSize: 1,
    },
  ]);
});

test("retainedEditingId clears when the edited row leaves the queue", () => {
  const items = [{ id: "fu_1" }, { id: "fu_2" }];
  expect(retainedEditingId("fu_1", items)).toBe("fu_1");
  expect(retainedEditingId("fu_gone", items)).toBeNull();
  expect(retainedEditingId("fu_1", [])).toBeNull();
  expect(retainedEditingId(null, items)).toBeNull();
});

test("followUpComposerCommit saves or drops the loaded queue row", () => {
  expect(
    followUpComposerCommit(null, { content: "new", attachments: [] }),
  ).toEqual({ action: "enqueue" });
  expect(
    followUpComposerCommit("fu_1", { content: "fixed", attachments: [{}] }),
  ).toEqual({ action: "update", id: "fu_1" });
  expect(
    followUpComposerCommit("fu_1", { content: "  ", attachments: [] }),
  ).toEqual({ action: "remove", id: "fu_1" });
});
