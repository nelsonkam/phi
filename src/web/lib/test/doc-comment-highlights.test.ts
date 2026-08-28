import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  COMMENT_INELIGIBLE_ATTR,
  paintDocCommentHighlights,
  unwrapDocCommentMarks,
} from "@/web/lib/doc-comment-projection";

function installDom(): Window {
  const window = new Window();
  const global = globalThis as typeof globalThis & {
    document: Document;
    NodeFilter: typeof NodeFilter;
    Node: typeof Node;
    Text: typeof Text;
    Element: typeof Element;
    HTMLElement: typeof HTMLElement;
    Range: typeof Range;
  };
  global.document = window.document as unknown as Document;
  global.NodeFilter = window.NodeFilter as unknown as typeof NodeFilter;
  global.Node = window.Node as unknown as typeof Node;
  global.Text = window.Text as unknown as typeof Text;
  global.Element = window.Element as unknown as typeof Element;
  global.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement;
  global.Range = window.Range as unknown as typeof Range;
  return window;
}

function markIds(root: Element): string[] {
  return [...root.querySelectorAll("mark")].map(
    (mark) => (mark as HTMLElement).dataset.docComment ?? "",
  );
}

test("two overlapping quotes in one paragraph paint without throwing", () => {
  const window = installDom();
  const root = window.document.createElement("div");
  root.innerHTML =
    "<p>The unique phrase lives here and is easy to select.</p>";
  window.document.body.appendChild(root);

  const painted = paintDocCommentHighlights(
    root as unknown as Element,
    [
      {
        id: "th_outer",
        quote: "The unique phrase lives here and is easy to select.",
        prefix: "",
        suffix: "",
        className: "outer",
      },
      {
        id: "th_inner",
        quote: "unique phrase",
        prefix: "The ",
        suffix: " lives",
        className: "inner",
      },
    ],
  );

  expect(painted.length).toBeGreaterThan(1);
  expect(new Set(markIds(root as unknown as Element))).toEqual(
    new Set(["th_outer", "th_inner"]),
  );
  expect(root.textContent).toBe(
    "The unique phrase lives here and is easy to select.",
  );

  unwrapDocCommentMarks(painted);
  expect(root.querySelectorAll("mark")).toHaveLength(0);
  expect(root.textContent).toBe(
    "The unique phrase lives here and is easy to select.",
  );
  window.close();
});

test("wrapRange skips data-comment-ineligible chrome inside a spanning range", () => {
  const window = installDom();
  const root = window.document.createElement("div");
  root.innerHTML = `<p>Hello <span ${COMMENT_INELIGIBLE_ATTR}>copy</span> world</p>`;
  window.document.body.appendChild(root);

  const painted = paintDocCommentHighlights(root as unknown as Element, [
    {
      id: "th_span",
      quote: "Hello world",
      prefix: "",
      suffix: "",
      className: "span",
    },
  ]);

  expect(painted.length).toBeGreaterThan(0);
  expect(root.querySelector(`[${COMMENT_INELIGIBLE_ATTR}]`)?.textContent).toBe(
    "copy",
  );
  expect(
    root.querySelector(`[${COMMENT_INELIGIBLE_ATTR}]`)?.closest("mark"),
  ).toBeNull();
  expect(root.textContent).toContain("copy");
  unwrapDocCommentMarks(painted);
  window.close();
});
