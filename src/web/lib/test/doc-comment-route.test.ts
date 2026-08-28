import { expect, test } from "bun:test";
import {
  shouldOpenChannelThreadPanel,
  shouldOpenActivityThreadPanel,
  docCommentDeepLink,
  docCommentScrollLatch,
} from "@/web/components/doc-comments";

test("a doc-comment thread id does not open channel chrome", () => {
  expect(
    shouldOpenChannelThreadPanel("th_doc", ["th_chat", "th_other"]),
  ).toBe(false);
  expect(shouldOpenChannelThreadPanel("th_chat", ["th_chat", "th_other"])).toBe(
    true,
  );
  expect(shouldOpenChannelThreadPanel("th_chat", undefined)).toBe(false);
  expect(shouldOpenChannelThreadPanel(undefined, ["th_chat"])).toBe(false);
});

test("doc-comment deep links canonicalize to the thread's channel", () => {
  const thread = {
    id: "th_doc",
    channelId: "ch_phi",
    kind: "doc_comment",
  };
  expect(docCommentDeepLink("ch_general", "doc", thread)).toBe(
    "/c/ch_phi/doc/th_doc",
  );
  expect(docCommentDeepLink("ch_phi", "doc", thread)).toBeNull();
  expect(docCommentDeepLink("ch_general", "thread", thread)).toBe(
    "/c/ch_phi/doc/th_doc",
  );
  expect(docCommentDeepLink("ch_phi", "thread", thread)).toBe(
    "/c/ch_phi/doc/th_doc",
  );
  expect(
    docCommentDeepLink("ch_phi", "doc", { ...thread, kind: "chat" }),
  ).toBeNull();
});

test("Activity /t/:threadId does not open chat chrome for a doc comment", () => {
  expect(shouldOpenActivityThreadPanel(undefined, false, undefined, false)).toBe(
    false,
  );
  expect(shouldOpenActivityThreadPanel("th_chat", true, undefined, false)).toBe(
    true,
  );
  expect(
    shouldOpenActivityThreadPanel("th_doc", false, undefined, false),
  ).toBe(false);
  expect(
    shouldOpenActivityThreadPanel("th_doc", false, "doc_comment", true),
  ).toBe(false);
  expect(shouldOpenActivityThreadPanel("th_chat", false, "chat", true)).toBe(
    true,
  );
});

test("deselecting a comment clears the scroll latch so the same thread can scroll again", () => {
  expect(docCommentScrollLatch("th_1", null)).toEqual({
    scroll: true,
    latch: "th_1",
  });
  expect(docCommentScrollLatch("th_1", "th_1")).toEqual({
    scroll: false,
    latch: "th_1",
  });
  expect(docCommentScrollLatch(null, "th_1")).toEqual({
    scroll: false,
    latch: null,
  });
  expect(docCommentScrollLatch("new", "th_1")).toEqual({
    scroll: false,
    latch: null,
  });
  expect(docCommentScrollLatch("th_1", null)).toEqual({
    scroll: true,
    latch: "th_1",
  });
});
