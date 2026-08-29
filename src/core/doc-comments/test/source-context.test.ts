import { expect, test } from "bun:test";
import {
  docSourceContext,
  formatDocCommentContext,
} from "@/core/doc-comments/source-context";

test("maps a rendered quote through mdast onto surrounding source", () => {
  const source = [
    "# Intro",
    "",
    "Hello **world** and `code`.",
    "",
    "More after.",
  ].join("\n");
  const ctx = docSourceContext(source, "notes.md", "world", "Hello ", " and ");
  expect(ctx.path).toBe("notes.md");
  expect(ctx.quote).toBe("world");
  expect(ctx.surrounding).toContain("Hello **world**");
  expect(formatDocCommentContext(ctx)).toContain("Quoted text:\nworld");
});

test("the comment-thread context carries the marginalia contract", () => {
  const prompt = formatDocCommentContext({
    path: "notes.md",
    quote: "world",
    surrounding: null,
  });
  expect(prompt).toContain("Reply as marginalia");
  expect(prompt).toContain("asked for an edit or clearly authorized one");
});
