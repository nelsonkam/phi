import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderRichText } from "@/web/lib/mentions";

function html(text: string): string {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {renderRichText(text, new Set())}
    </QueryClientProvider>,
  );
}

test("labeled markdown file links render as one chip using the label", () => {
  const markup = html("See [proposal](channels/design/proposal.md) please");
  expect(markup).toContain("proposal");
  expect(markup).toContain("<button");
  expect(markup).not.toContain("[proposal](");
  expect(markup).not.toContain("channels/design/proposal.md)");
});

test("bare workspace paths still chip", () => {
  const markup = html("See channels/design/proposal.md please");
  expect(markup).toContain("proposal.md");
  expect(markup).toContain("<button");
});

test("root-level labeled markdown links chip without a slash in the message", () => {
  const markup = html("See [readme](README.md) please");
  expect(markup).toContain("readme");
  expect(markup).toContain("<button");
  expect(markup).not.toContain("[readme](");
});
