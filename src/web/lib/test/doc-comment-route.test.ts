import { expect, test } from "bun:test";
import {
  shouldOpenChannelThreadPanel,
  shouldOpenActivityThreadPanel,
  docCommentDeepLink,
  docCommentScrollLatch,
  docCommentSyncPath,
  commentReplyPlaceholder,
  shouldOpenThreadFromClick,
  shouldSelectExistingComment,
  mergeBrowseFileFromDocLink,
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

test("comment composers name the fallback agent", () => {
  expect(commentReplyPlaceholder("grok", "reply")).toBe(
    "Reply — @grok will answer",
  );
  expect(commentReplyPlaceholder("grok", "new")).toBe(
    "Add a comment — @grok will answer",
  );
  expect(commentReplyPlaceholder(null, "reply")).toBe("Reply");
});

test("thread row clicks ignore portal targets outside the row", () => {
  expect(shouldOpenThreadFromClick(null, null)).toBe(false);
});

test("a drag-select over an existing highlight does not steal the comment popover", () => {
  const inside = {} as Node;
  const outside = {} as Node;
  const root = { contains: (node: Node | null) => node === inside };
  expect(shouldSelectExistingComment(null, root as unknown as Node)).toBe(true);
  expect(
    shouldSelectExistingComment(
      { isCollapsed: true, anchorNode: inside },
      root as unknown as Node,
    ),
  ).toBe(true);
  expect(
    shouldSelectExistingComment(
      { isCollapsed: false, anchorNode: inside },
      root as unknown as Node,
    ),
  ).toBe(false);
  expect(
    shouldSelectExistingComment(
      { isCollapsed: false, anchorNode: outside },
      root as unknown as Node,
    ),
  ).toBe(true);
});

test("deep-link rehydration keeps chip parent lineage on the same doc", () => {
  const fromChip = {
    path: "channels/design/proposal.md",
    root: "workspace",
    parentThreadId: "th_chat",
    fragment: "intro",
  };
  expect(
    mergeBrowseFileFromDocLink(fromChip, {
      path: "channels/design/proposal.md",
      root: "workspace",
      commentId: "th_doc",
    }),
  ).toEqual({
    path: "channels/design/proposal.md",
    root: "workspace",
    commentId: "th_doc",
    parentThreadId: "th_chat",
    fragment: "intro",
  });
  expect(
    mergeBrowseFileFromDocLink(fromChip, {
      path: "channels/other.md",
      root: "workspace",
      commentId: "th_other",
    }),
  ).toEqual({
    path: "channels/other.md",
    root: "workspace",
    commentId: "th_other",
    parentThreadId: undefined,
    fragment: undefined,
  });
  const unresolvedChip = {
    path: "src/notes.md",
    parentThreadId: "th_chat",
  };
  expect(
    mergeBrowseFileFromDocLink(unresolvedChip, {
      path: "src/notes.md",
      root: "phi",
      commentId: "th_doc",
    }),
  ).toEqual({
    path: "src/notes.md",
    root: "phi",
    commentId: "th_doc",
    parentThreadId: "th_chat",
    fragment: undefined,
  });
});

test("syncRoute writes the comment URL and pops it when selection clears", () => {
  expect(docCommentSyncPath("ch_phi", "th_1", "/c/ch_phi")).toBe(
    "/c/ch_phi/doc/th_1",
  );
  expect(docCommentSyncPath("ch_phi", "th_1", "/c/ch_phi/doc/th_1")).toBe(
    "/c/ch_phi/doc/th_1",
  );
  expect(docCommentSyncPath("ch_phi", null, "/c/ch_phi/doc/th_1")).toBe(
    "/c/ch_phi",
  );
  expect(docCommentSyncPath("ch_phi", "new", "/c/ch_phi/doc/th_1")).toBe(
    "/c/ch_phi",
  );
  expect(docCommentSyncPath("ch_phi", null, "/c/ch_phi")).toBeNull();
  expect(docCommentSyncPath("ch_phi", null, "/c/ch_phi/t/th_chat")).toBeNull();
});
