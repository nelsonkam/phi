import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "@/web/components/composer";

function installDom(): Window {
  const happy = new Window();
  Object.assign(globalThis, {
    window: happy,
    document: happy.document,
    HTMLElement: happy.HTMLElement,
    HTMLTextAreaElement: happy.HTMLTextAreaElement,
    requestAnimationFrame: (cb: FrameRequestCallback) =>
      Number(happy.requestAnimationFrame(cb)),
    cancelAnimationFrame: (id: number) =>
      happy.cancelAnimationFrame(id as never),
  });
  return happy;
}

async function flushFocus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) =>
    requestAnimationFrame(() => resolve(undefined)),
  );
}

function renderComposer(
  root: Root,
  client: QueryClient,
  props: { autoFocus?: boolean; draftKey?: string },
) {
  root.render(
    <QueryClientProvider client={client}>
      <Composer
        placeholder="Message #general"
        autoFocus={props.autoFocus}
        draftKey={props.draftKey}
        onSend={() => undefined}
      />
    </QueryClientProvider>,
  );
}

function composerFocused(happy: Window): boolean {
  return happy.document.activeElement?.tagName === "TEXTAREA";
}

function blurComposer(happy: Window) {
  const el = happy.document.querySelector("textarea");
  if (el && "blur" in el && typeof el.blur === "function") el.blur();
}

function mountRoot(happy: Window): { root: Root; client: QueryClient } {
  const host = happy.document.createElement("div");
  happy.document.body.appendChild(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { root: createRoot(host as unknown as Element), client };
}

test("autoFocus focuses the composer textarea", async () => {
  const happy = installDom();
  const { root, client } = mountRoot(happy);
  renderComposer(root, client, { autoFocus: true });
  await flushFocus();
  expect(composerFocused(happy)).toBe(true);
  root.unmount();
  happy.close();
});

test("the composer stays unfocused without autoFocus", async () => {
  const happy = installDom();
  const { root, client } = mountRoot(happy);
  renderComposer(root, client, { autoFocus: false });
  await flushFocus();
  expect(composerFocused(happy)).toBe(false);
  root.unmount();
  happy.close();
});

test("autoFocus restores after a draftKey change", async () => {
  const happy = installDom();
  const { root, client } = mountRoot(happy);

  renderComposer(root, client, { autoFocus: true, draftKey: "channel:a" });
  await flushFocus();
  blurComposer(happy);
  expect(composerFocused(happy)).toBe(false);

  renderComposer(root, client, { autoFocus: true, draftKey: "channel:b" });
  await flushFocus();
  expect(composerFocused(happy)).toBe(true);
  root.unmount();
  happy.close();
});

test("autoFocus takes the textarea when the flag turns on", async () => {
  const happy = installDom();
  const { root, client } = mountRoot(happy);

  renderComposer(root, client, { autoFocus: false });
  await flushFocus();
  expect(composerFocused(happy)).toBe(false);

  renderComposer(root, client, { autoFocus: true });
  await flushFocus();
  expect(composerFocused(happy)).toBe(true);
  root.unmount();
  happy.close();
});
