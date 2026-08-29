import { expect, test } from "bun:test";
import { readDraft, readComposerDraft, saveDraft, saveComposerDraft, readDocCommentAnchor, saveDocCommentAnchor, clearDocCommentAnchor, docCommentDraftKey } from "@/web/lib/drafts";

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

test("round-trips a draft per key", () => {
  const storage = fakeStorage();
  saveDraft("thread:t1", "hello @researcher", storage);
  saveDraft("channel:c1", "channel note", storage);
  expect(readDraft("thread:t1", storage)).toBe("hello @researcher");
  expect(readDraft("channel:c1", storage)).toBe("channel note");
  expect(readDraft("thread:t2", storage)).toBeNull();
});

test("saving blank text removes the stored draft", () => {
  const storage = fakeStorage();
  saveDraft("thread:t1", "draft", storage);
  saveDraft("thread:t1", "  \n", storage);
  expect(readDraft("thread:t1", storage)).toBeNull();
  expect(storage.length).toBe(0);
});

test("swallows storage errors", () => {
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
  expect(() => saveDraft("k", "text", throwing)).not.toThrow();
  expect(readDraft("k", throwing)).toBeNull();
});

test("missing storage acts as no drafts", () => {
  expect(readDraft("k", undefined)).toBeNull();
  expect(() => saveDraft("k", "text", undefined)).not.toThrow();
});

test("persists uploaded attachment ids alongside text", () => {
  const storage = fakeStorage();
  const id = `att_${"e".repeat(32)}`;
  saveComposerDraft(
    "thread:t1",
    {
      text: "see this",
      attachments: [
        {
          id,
          filename: "shot.png",
          contentType: "image/png",
          byteSize: 12,
        },
      ],
    },
    storage,
  );
  expect(readDraft("thread:t1", storage)).toBe("see this");
  expect(readComposerDraft("thread:t1", storage)).toEqual({
    text: "see this",
    attachments: [
      {
        id,
        filename: "shot.png",
        contentType: "image/png",
        byteSize: 12,
      },
    ],
  });
  saveComposerDraft("thread:t1", { text: "", attachments: [] }, storage);
  expect(readComposerDraft("thread:t1", storage)).toBeNull();
});

test("persists a doc-comment draft anchor", () => {
  const storage = fakeStorage();
  saveDocCommentAnchor(
    "doc-comment-new:ch:notes.md",
    { quote: "hello world", prefix: "say ", suffix: " now", headingSlug: "intro" },
    storage,
  );
  expect(readDocCommentAnchor("doc-comment-new:ch:notes.md", storage)).toEqual({
    quote: "hello world",
    prefix: "say ",
    suffix: " now",
    headingSlug: "intro",
  });
  clearDocCommentAnchor("doc-comment-new:ch:notes.md", storage);
  expect(readDocCommentAnchor("doc-comment-new:ch:notes.md", storage)).toBeNull();
});

test("doc-comment draft keys include the file root", () => {
  expect(docCommentDraftKey("ch_1", "workspace", "channels/a.md")).toBe(
    "doc-comment-new:ch_1:workspace:channels/a.md",
  );
  expect(docCommentDraftKey("ch_1", "workspace", "src/a.md")).not.toBe(
    docCommentDraftKey("ch_1", "phi", "src/a.md"),
  );
});
