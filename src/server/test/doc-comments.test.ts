import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PhiStore } from "@/core/store/store";
import {
  parseDocCommentBody,
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
