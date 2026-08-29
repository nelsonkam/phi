import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PhiStore } from "@/core/store/store";
import {
  parseDocCommentBody,
  resolveDocCommentParent,
  resolveMarkdownDoc,
} from "@/server/doc-comments";
import { tempDir } from "@/testing/tmpdir";

test("rejects missing quote and non-markdown paths", () => {
  expect(parseDocCommentBody({ content: "hi" }).ok).toBe(false);
  expect(
    parseDocCommentBody({
      content: "hi",
      rootId: "workspace",
      path: "notes.md",
      quote: "",
    }).ok,
  ).toBe(false);
  expect(
    parseDocCommentBody({
      content: "hi",
      rootId: "workspace",
      path: "notes.md",
      quote: "hello",
      prefix: "",
      suffix: "",
    }).ok,
  ).toBe(true);
  const withParent = parseDocCommentBody({
    content: "hi",
    rootId: "workspace",
    path: "notes.md",
    quote: "hello",
    prefix: "",
    suffix: "",
    parentThreadId: "th_parent",
  });
  expect(withParent.ok).toBe(true);
  if (withParent.ok) expect(withParent.value.parentThreadId).toBe("th_parent");
  expect(
    parseDocCommentBody({
      content: "hi",
      rootId: "workspace",
      path: "notes.md",
      quote: "hello",
      prefix: "",
      suffix: "",
      parentThreadId: 1,
    }).ok,
  ).toBe(false);
  expect(
    parseDocCommentBody({
      content: "",
      rootId: "workspace",
      path: "notes.md",
      quote: "hello",
      prefix: "",
      suffix: "",
    }).ok,
  ).toBe(true);
});

test("resolves markdown through the file-root checker and rejects other types", () => {
  const root = tempDir();
  const store = new PhiStore(root);
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  mkdirSync(join(workspace.rootPath, "channels", "general"), { recursive: true });
  writeFileSync(join(workspace.rootPath, "channels", "general", "notes.md"), "# Hi\n");
  writeFileSync(join(workspace.rootPath, "photo.png"), "not markdown");

  const md = resolveMarkdownDoc(
    store,
    workspace.rootPath,
    channel.id,
    "workspace",
    "channels/general/notes.md",
  );
  expect(md.ok).toBe(true);

  const png = resolveMarkdownDoc(
    store,
    workspace.rootPath,
    channel.id,
    "workspace",
    "photo.png",
  );
  expect(png.ok).toBe(false);
  if (!png.ok) expect(png.status).toBe(400);

  const missing = resolveMarkdownDoc(
    store,
    workspace.rootPath,
    channel.id,
    "workspace",
    "nope.md",
  );
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.status).toBe(404);

  const escaped = resolveMarkdownDoc(
    store,
    workspace.rootPath,
    channel.id,
    "workspace",
    "../secret.md",
  );
  expect(escaped.ok).toBe(false);
  store.close();
});

test("resolves a requested parent and falls back to existing comments or a linking message", () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const parent = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "See [notes](channels/general/notes.md)",
  });
  const other = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "unrelated",
  });

  const requested = resolveDocCommentParent(
    store,
    channel.id,
    "workspace",
    "channels/general/notes.md",
    parent.thread.id,
  );
  expect(requested).toEqual({ ok: true, parentThreadId: parent.thread.id });

  const bad = resolveDocCommentParent(
    store,
    channel.id,
    "workspace",
    "channels/general/notes.md",
    "th_missing",
  );
  expect(bad.ok).toBe(false);

  const fromLink = resolveDocCommentParent(
    store,
    channel.id,
    "workspace",
    "channels/general/notes.md",
    null,
  );
  expect(fromLink).toEqual({ ok: true, parentThreadId: parent.thread.id });

  store.createDocComment(
    channel.id,
    { author: "user", kind: "message", content: "first" },
    {
      rootId: "workspace",
      path: "channels/general/notes.md",
      quote: "hello",
      prefix: "",
      suffix: "",
      headingSlug: null,
      parentThreadId: other.thread.id,
    },
  );
  const fromExisting = resolveDocCommentParent(
    store,
    channel.id,
    "workspace",
    "channels/general/notes.md",
    null,
  );
  expect(fromExisting).toEqual({ ok: true, parentThreadId: other.thread.id });
  store.close();
});
