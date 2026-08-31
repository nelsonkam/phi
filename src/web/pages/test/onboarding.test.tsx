import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { queryKeys } from "@/web/lib/queries";
import { Onboarding } from "@/web/pages/onboarding";

function installDom(): Window {
  const happy = new Window();
  Object.assign(globalThis, {
    window: happy,
    document: happy.document,
    HTMLElement: happy.HTMLElement,
    HTMLInputElement: happy.HTMLInputElement,
    HTMLFormElement: happy.HTMLFormElement,
  });
  return happy;
}

test("onboarding name pattern is the HTML v-flag kebab-case pattern", async () => {
  const happy = installDom();
  const host = happy.document.createElement("div");
  happy.document.body.appendChild(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.harnesses, {
    harnesses: [
      {
        id: "claude-code",
        name: "Claude Code",
        installed: false,
        installHint: "install claude",
      },
    ],
  });
  const root = createRoot(host as unknown as Element);
  root.render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Onboarding />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const name = happy.document.querySelector(
    'input[placeholder="default"]',
  ) as HTMLInputElement | null;
  expect(name).not.toBeNull();
  const pattern = name!.getAttribute("pattern");
  expect(pattern).toBe("[a-z0-9][a-z0-9\\-]*");
  const re = new RegExp(`^${pattern}$`, "v");
  expect(re.test("grok")).toBe(true);
  expect(re.test("my-bot")).toBe(true);
  expect(re.test("Grok")).toBe(false);
  expect(re.test("-x")).toBe(false);

  const logo = happy.document.querySelector('img[src="/favicon.png"]');
  expect(logo).not.toBeNull();
  expect(logo!.className).toContain("ring-1");
  expect(logo!.className).not.toContain("invert");

  root.unmount();
});
