import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFileHandler, resolveWorkspaceFile } from "@/server/files";
import { tempDir } from "@/testing/tmpdir";

function workspaceWithFiles(): { root: string; outside: string } {
  const base = tempDir();
  const root = join(base, "workspace");
  const outside = join(base, "secret.txt");
  mkdirSync(join(root, "channels", "general"), { recursive: true });
  writeFileSync(join(root, "channels", "general", "report.md"), "# Report\n");
  writeFileSync(join(root, "notes.txt"), "notes");
  writeFileSync(outside, "outside the workspace");
  return { root, outside };
}

test("resolves files inside the workspace", () => {
  const { root } = workspaceWithFiles();
  expect(resolveWorkspaceFile(root, "channels/general/report.md")).toContain(
    "report.md",
  );
  expect(resolveWorkspaceFile(root, "./notes.txt")).toContain("notes.txt");
  // An absolute path is fine when it stays inside the workspace.
  expect(resolveWorkspaceFile(root, join(root, "notes.txt"))).toContain(
    "notes.txt",
  );
});

test("rejects traversal, absolute escapes, directories, and missing files", () => {
  const { root, outside } = workspaceWithFiles();
  expect(resolveWorkspaceFile(root, "../secret.txt")).toBeNull();
  expect(
    resolveWorkspaceFile(root, "channels/../../secret.txt"),
  ).toBeNull();
  expect(resolveWorkspaceFile(root, outside)).toBeNull();
  expect(resolveWorkspaceFile(root, "channels/general")).toBeNull();
  expect(resolveWorkspaceFile(root, "missing.md")).toBeNull();
  expect(resolveWorkspaceFile(root, "")).toBeNull();
  expect(resolveWorkspaceFile(root, "notes.txt\0.png")).toBeNull();
});

test("rejects symlinks that escape the workspace", () => {
  const { root, outside } = workspaceWithFiles();
  symlinkSync(outside, join(root, "sneaky.txt"));
  expect(resolveWorkspaceFile(root, "sneaky.txt")).toBeNull();
  // A symlink that stays inside the workspace still resolves.
  symlinkSync(join(root, "notes.txt"), join(root, "alias.txt"));
  expect(resolveWorkspaceFile(root, "alias.txt")).toContain("notes.txt");
});

test("the handler serves workspace files with a content type", async () => {
  const { root } = workspaceWithFiles();
  const handler = createFileHandler(root);

  const ok = await handler(
    new Request("http://localhost/api/v1/files/channels/general/report.md"),
  );
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toContain("markdown");
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(await ok.text()).toBe("# Report\n");

  const encoded = await handler(
    new Request(
      "http://localhost/api/v1/files/channels%2Fgeneral%2Freport.md",
    ),
  );
  expect(encoded.status).toBe(200);
});

test("html responses carry the no-script CSP; other types do not", async () => {
  const { root } = workspaceWithFiles();
  writeFileSync(
    join(root, "page.html"),
    "<h1>hi</h1><script>document.title = 'ran'</script>",
  );
  const handler = createFileHandler(root);

  const page = await handler(
    new Request("http://localhost/api/v1/files/page.html"),
  );
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("html");
  expect(page.headers.get("content-security-policy")).toContain(
    "script-src 'none'",
  );
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");

  const markdown = await handler(
    new Request("http://localhost/api/v1/files/channels/general/report.md"),
  );
  expect(markdown.headers.get("content-security-policy")).toBeNull();
});

test("the handler 404s everything the resolver rejects", async () => {
  const { root } = workspaceWithFiles();
  const handler = createFileHandler(root);
  for (const path of [
    "../secret.txt",
    "..%2Fsecret.txt",
    "missing.md",
    "channels/general",
  ]) {
    const res = await handler(
      new Request(`http://localhost/api/v1/files/${path}`),
    );
    expect(res.status).toBe(404);
  }
});
