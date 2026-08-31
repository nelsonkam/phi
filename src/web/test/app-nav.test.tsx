import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { Channel } from "@/shared/types";
import { queryKeys } from "@/web/lib/queries";

mock.module("@/web/lib/ws", () => ({
  connectDeltaSocket: () => () => {},
}));

const { App, Page } = await import("@/web/app");

function installDom(width: number): Window {
  const happy = new Window({ width, height: 800 });
  Object.assign(globalThis, {
    window: happy,
    document: happy.document,
    HTMLElement: happy.HTMLElement,
    HTMLButtonElement: happy.HTMLButtonElement,
    HTMLAnchorElement: happy.HTMLAnchorElement,
    KeyboardEvent: happy.KeyboardEvent,
  });
  return happy;
}

function channel(): Channel {
  return {
    id: "ch_general",
    workspaceId: "ws",
    name: "general",
    purpose: null,
    folders: [],
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

function mountApp(happy: Window): Root {
  const host = happy.document.createElement("div");
  happy.document.body.appendChild(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.channels, { channels: [channel()] });
  client.setQueryData(queryKeys.activity, {
    pages: [{ activity: [], waitingCount: 2 }],
    pageParams: [undefined],
  });
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <App />,
        children: [
          {
            index: true,
            element: (
              <Page title="Activity">
                <span>activity-body</span>
              </Page>
            ),
          },
          {
            path: "c/:channelId",
            element: (
              <Page title="Channel">
                <span>channel-body</span>
              </Page>
            ),
          },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
  const root = createRoot(host as unknown as Element);
  root.render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function nav(happy: Window): HTMLElement {
  const el = happy.document.getElementById("app-nav");
  if (!el) throw new Error("missing #app-nav");
  return el as unknown as HTMLElement;
}

function menuButton(happy: Window): HTMLButtonElement {
  const el = happy.document.querySelector(
    '[aria-label="Open navigation"]',
  ) as HTMLButtonElement | null;
  if (!el) throw new Error("missing open-navigation button");
  return el;
}

test("narrow viewport keeps the sidebar closed until the menu is opened", async () => {
  const happy = installDom(390);
  const root = mountApp(happy);
  await flush();

  const aside = nav(happy);
  expect(aside.getAttribute("data-state")).toBe("closed");
  expect(aside.getAttribute("role")).toBeNull();
  expect(menuButton(happy).getAttribute("aria-expanded")).toBe("false");
  expect(
    happy.document.querySelector('[aria-label="Close navigation"]'),
  ).toBeNull();

  menuButton(happy).click();
  await waitFor(
    () => aside.getAttribute("data-state") === "open",
    "drawer to open",
  );

  expect(aside.getAttribute("data-state")).toBe("open");
  expect(aside.getAttribute("role")).toBe("dialog");
  expect(aside.getAttribute("aria-modal")).toBe("true");
  expect(menuButton(happy).getAttribute("aria-expanded")).toBe("true");
  expect(
    happy.document.querySelector('[aria-label="Close navigation"]'),
  ).toBeTruthy();
  expect(happy.document.body.textContent).toContain("general");
  expect(
    aside.contains(happy.document.activeElement as unknown as Node),
  ).toBe(true);

  root.unmount();
  happy.close();
});

test("opening a channel from the drawer closes the navigation", async () => {
  const happy = installDom(390);
  const root = mountApp(happy);
  await flush();

  menuButton(happy).click();
  await waitFor(
    () => nav(happy).getAttribute("data-state") === "open",
    "drawer to open",
  );

  const link = [...happy.document.querySelectorAll("a")].find((el) =>
    el.textContent?.includes("general"),
  );
  expect(link).toBeTruthy();
  link!.click();
  await waitFor(
    () => nav(happy).getAttribute("data-state") === "closed",
    "drawer to close after navigation",
  );
  expect(happy.document.body.textContent).toContain("channel-body");
  expect(menuButton(happy).getAttribute("aria-expanded")).toBe("false");
  expect(happy.document.activeElement as unknown).toBe(menuButton(happy));

  root.unmount();
  happy.close();
});

test("Escape closes the drawer and prevents the bubble-phase keydown", async () => {
  const happy = installDom(390);
  const root = mountApp(happy);
  await flush();

  menuButton(happy).click();
  await waitFor(
    () => nav(happy).getAttribute("data-state") === "open",
    "drawer to open",
  );

  const unprevented: boolean[] = [];
  const onBubble = (event: Event) => {
    const keyEvent = event as unknown as KeyboardEvent;
    if (keyEvent.key === "Escape") unprevented.push(!keyEvent.defaultPrevented);
  };
  happy.window.addEventListener("keydown", onBubble as never);

  happy.window.dispatchEvent(
    new happy.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }) as never,
  );
  await flush();

  happy.window.removeEventListener("keydown", onBubble as never);
  await waitFor(
    () => nav(happy).getAttribute("data-state") === "closed",
    "drawer to close on Escape",
  );
  expect(unprevented).toEqual([false]);

  root.unmount();
  happy.close();
});

test("desktop layout leaves the sidebar open without needing the menu", async () => {
  const happy = installDom(1024);
  const root = mountApp(happy);
  await flush();

  expect(nav(happy).getAttribute("data-state")).toBe("closed");
  expect(nav(happy).getAttribute("role")).toBeNull();
  expect(happy.document.body.textContent).toContain("general");
  expect(
    happy.document.querySelector('[aria-label="Close navigation"]'),
  ).toBeNull();

  root.unmount();
  happy.close();
});

test("page can shrink inside the outlet shell so its body remains scrollable", async () => {
  const happy = installDom(1024);
  const root = mountApp(happy);
  await flush();

  const page = happy.document.querySelector("main");
  expect(page).toBeTruthy();
  expect(page!.classList.contains("min-h-0")).toBe(true);

  root.unmount();
  happy.close();
});

test("Cmd-K while the drawer is closed does not skip the next focus restore", async () => {
  const happy = installDom(390);
  const root = mountApp(happy);
  await flush();

  happy.window.dispatchEvent(
    new happy.KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }) as never,
  );
  await flush();
  happy.window.dispatchEvent(
    new happy.KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }) as never,
  );
  await flush();

  menuButton(happy).click();
  await waitFor(
    () => nav(happy).getAttribute("data-state") === "open",
    "drawer to open",
  );

  (
    happy.document.querySelector(
      '[aria-label="Close navigation"]',
    ) as unknown as HTMLButtonElement
  ).click();
  await waitFor(
    () => nav(happy).getAttribute("data-state") === "closed",
    "drawer to close",
  );
  expect(happy.document.activeElement as unknown).toBe(menuButton(happy));

  root.unmount();
  happy.close();
});
