import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GitRemoteSettings } from "@/shared/types";
import { queryKeys } from "@/web/lib/queries";
import { SettingsPage } from "@/web/pages/settings";

function installDom(): Window {
  const happy = new Window();
  Object.assign(globalThis, {
    window: happy,
    document: happy.document,
    HTMLElement: happy.HTMLElement,
    HTMLInputElement: happy.HTMLInputElement,
  });
  return happy;
}

function mountPage(happy: Window, payload: GitRemoteSettings): Root {
  const host = happy.document.createElement("div");
  happy.document.body.appendChild(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.gitRemoteSettings, payload);
  const root = createRoot(host as unknown as Element);
  root.render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function settings(overrides: Partial<GitRemoteSettings> = {}): GitRemoteSettings {
  return {
    url: "git@github.com:you/phi-workspace.git",
    source: "file",
    locked: false,
    parseError: null,
    health: {
      status: "ok",
      configured: true,
      displayUrl: null,
      lastPushedSha: "abcdef0",
      error: null,
    },
    ...overrides,
  };
}

test("settings page fills the remote URL", async () => {
  const happy = installDom();
  const root = mountPage(happy, settings());
  await flush();
  const input = happy.document.querySelector("#git-remote-url") as HTMLInputElement | null;
  expect(input?.value).toBe("git@github.com:you/phi-workspace.git");
  expect(happy.document.body.textContent).toContain("Last push succeeded");
  root.unmount();
  happy.close();
});

test("env-locked remote disables the URL field", async () => {
  const happy = installDom();
  const root = mountPage(
    happy,
    settings({
      source: "env",
      locked: true,
    }),
  );
  await flush();
  const input = happy.document.querySelector("#git-remote-url") as HTMLInputElement | null;
  expect(input?.disabled).toBe(true);
  expect(happy.document.body.textContent).toContain("PHI_GIT_REMOTE");
  root.unmount();
  happy.close();
});
