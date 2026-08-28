import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownFileView } from "@/web/components/file-link";
import {
  scrollToDocCommentAnchor,
  scrollToHeadingFragment,
  slugifyHeading,
  uniqueHeadingId,
} from "@/web/lib/heading-ids";

const SAMPLE = `# Intro

Some preamble.

## Summary

The answer.

## Next steps
`;

test("MarkdownFileView renders stable heading ids and keeps the fragment", () => {
  const html = renderToStaticMarkup(
    <MarkdownFileView text={SAMPLE} fragment="summary" />,
  );
  expect(html).toContain('data-fragment="summary"');
  expect(html).toContain('id="intro"');
  expect(html).toContain('id="summary"');
  expect(html).toContain('id="next-steps"');
});

test("duplicate headings get numeric suffixes", () => {
  const used = new Map<string, number>();
  expect(uniqueHeadingId("Summary", used)).toBe("summary");
  expect(uniqueHeadingId("Summary", used)).toBe("summary-1");
  expect(slugifyHeading("1. Next Steps")).toBe("1-next-steps");
});

test("scrollToHeadingFragment calls scrollIntoView on the matching heading", () => {
  const scrolled: string[] = [];
  const target = {
    id: "summary",
    scrollIntoView() {
      scrolled.push("summary");
    },
  };
  const root = {
    querySelector(selector: string) {
      return selector === "#summary" ? target : null;
    },
  };
  expect(scrollToHeadingFragment(root, "#Summary")).toBe(target);
  expect(scrolled).toEqual(["summary"]);
});

test("scrollToDocCommentAnchor prefers the highlight, then heading slug", () => {
  const scrolled: string[] = [];
  const mark = {
    scrollIntoView() {
      scrolled.push("mark");
    },
  };
  const heading = {
    id: "summary",
    scrollIntoView() {
      scrolled.push("heading");
    },
  };
  const withMark = {
    querySelector(selector: string) {
      if (selector.includes("th_1")) return mark;
      return selector === "#summary" ? heading : null;
    },
  };
  scrollToDocCommentAnchor(withMark, {
    threadId: "th_1",
    headingSlug: "summary",
  });
  expect(scrolled).toEqual(["mark"]);

  const detached = {
    querySelector(selector: string) {
      return selector === "#summary" ? heading : null;
    },
  };
  scrollToDocCommentAnchor(detached, {
    threadId: "th_1",
    headingSlug: "summary",
  });
  expect(scrolled).toEqual(["mark", "heading"]);
});
