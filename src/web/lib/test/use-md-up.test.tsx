import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { useMdUp } from "@/web/lib/use-md-up";

function installDom(width: number): Window {
  const happy = new Window({ width, height: 800 });
  Object.assign(globalThis, {
    window: happy,
    document: happy.document,
    HTMLElement: happy.HTMLElement,
  });
  return happy;
}

function Probe({ onValue }: { onValue: (value: boolean) => void }) {
  const mdUp = useMdUp();
  onValue(mdUp);
  return null;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("useMdUp is false below the md breakpoint", async () => {
  const happy = installDom(390);
  const host = happy.document.createElement("div");
  happy.document.body.appendChild(host);
  let value: boolean | undefined;
  const root: Root = createRoot(host as unknown as Element);
  root.render(<Probe onValue={(next) => { value = next; }} />);
  await flush();
  expect(value).toBe(false);
  root.unmount();
  happy.close();
});

test("useMdUp is true at the md breakpoint", async () => {
  const happy = installDom(768);
  const host = happy.document.createElement("div");
  happy.document.body.appendChild(host);
  let value: boolean | undefined;
  const root: Root = createRoot(host as unknown as Element);
  root.render(<Probe onValue={(next) => { value = next; }} />);
  await flush();
  expect(value).toBe(true);
  root.unmount();
  happy.close();
});
