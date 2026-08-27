import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpandableImage } from "@/web/components/image-lightbox";

test("ExpandableImage renders a zoom control around the thumbnail", () => {
  const html = renderToStaticMarkup(
    <ExpandableImage src="/api/v1/files/chart.png" alt="Revenue chart" />,
  );
  expect(html).toContain("<button");
  expect(html).toContain("Expand Revenue chart");
  expect(html).toContain('src="/api/v1/files/chart.png"');
  expect(html).toContain('alt="Revenue chart"');
  expect(html).toContain("cursor-zoom-in");
  expect(html).not.toContain("my-3");
});

test("missing alt falls back to the file basename", () => {
  const html = renderToStaticMarkup(
    <ExpandableImage src="/api/v1/files/screenshots/shot.png" alt="" />,
  );
  expect(html).toContain("Expand shot.png");
});

test("fallbackLabel wins over a basename derived from src", () => {
  const html = renderToStaticMarkup(
    <ExpandableImage
      src="/api/v1/files/encoded"
      alt=""
      fallbackLabel="screenshot.png"
    />,
  );
  expect(html).toContain("Expand screenshot.png");
});

test("empty src is a plain image, not a dead zoom control", () => {
  const html = renderToStaticMarkup(<ExpandableImage src="" alt="Broken" />);
  expect(html).not.toContain("<button");
  expect(html).toContain("<img");
  expect(html).toContain('alt="Broken"');
});
