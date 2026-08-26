import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PhiStore } from "@/core/store/store";
import {
  createFileHandler,
  listFileRoots,
  resolveFileInRoots,
  resolveWorkspaceFile,
  WORKSPACE_ROOT_ID,
} from "@/server/files";
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

test("lists workspace plus unique folder basenames as file roots", () => {
  const roots = listFileRoots("/ws", ["/proj/app", "/other/app", "/docs"]);
  expect(roots.map((root) => root.id)).toEqual([
    WORKSPACE_ROOT_ID,
    "app",
    "app-2",
    "docs",
  ]);
});

test("resolveFileInRoots searches or pins a root and rejects escapes", () => {
  const { root, outside } = workspaceWithFiles();
  const attached = tempDir();
  writeFileSync(join(attached, "readme.md"), "attached");
  writeFileSync(join(root, "readme.md"), "workspace");
  const roots = listFileRoots(root, [attached]);
  const folderId = basename(attached);

  const pinned = resolveFileInRoots(roots, "readme.md", folderId);
  expect(pinned.ok).toBe(true);
  if (pinned.ok) expect(pinned.root.id).toBe(folderId);

  const ambiguous = resolveFileInRoots(roots, "readme.md");
  expect(ambiguous).toMatchObject({ ok: false, reason: "ambiguous" });

  const unique = resolveFileInRoots(roots, "notes.txt");
  expect(unique.ok).toBe(true);
  if (unique.ok) expect(unique.root.id).toBe(WORKSPACE_ROOT_ID);

  expect(resolveFileInRoots(roots, "../secret.txt", folderId).ok).toBe(false);
  expect(resolveFileInRoots(roots, outside, folderId).ok).toBe(false);
});

test("channel search redirects to the matching file-root URL", async () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const { root } = workspaceWithFiles();
  const attached = tempDir();
  writeFileSync(join(attached, "readme.md"), "from attached\n");
  const channel = store.createChannel(workspace.id, {
    name: "code",
    folders: [attached],
  });
  const handler = createFileHandler(root, store);
  const folderId = basename(attached);

  const search = await handler(
    new Request(
      `http://localhost/api/v1/channels/${channel.id}/files/readme.md`,
    ),
  );
  expect(search.status).toBe(302);
  expect(search.headers.get("location")).toBe(
    `/api/v1/channels/${channel.id}/file-roots/${folderId}/readme.md`,
  );

  const canonical = await handler(
    new Request(`http://localhost${search.headers.get("location")}`),
  );
  expect(canonical.status).toBe(200);
  expect(await canonical.text()).toBe("from attached\n");

  const workspaceHit = await handler(
    new Request(
      `http://localhost/api/v1/channels/${channel.id}/files/channels/general/report.md`,
    ),
  );
  expect(workspaceHit.status).toBe(302);
  expect(workspaceHit.headers.get("location")).toContain(
    `/file-roots/${WORKSPACE_ROOT_ID}/channels/general/report.md`,
  );

  store.close();
});

test("channel search 409s when two roots share a path", async () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const { root } = workspaceWithFiles();
  writeFileSync(join(root, "clash.md"), "workspace copy");
  const attached = tempDir();
  writeFileSync(join(attached, "clash.md"), "folder copy");
  const channel = store.createChannel(workspace.id, {
    name: "clash",
    folders: [attached],
  });
  const handler = createFileHandler(root, store);

  const res = await handler(
    new Request(
      `http://localhost/api/v1/channels/${channel.id}/files/clash.md`,
    ),
  );
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: "ambiguous" });

  const pinned = await handler(
    new Request(
      `http://localhost/api/v1/channels/${channel.id}/file-roots/${WORKSPACE_ROOT_ID}/clash.md`,
    ),
  );
  expect(pinned.status).toBe(200);
  expect(await pinned.text()).toBe("workspace copy");

  store.close();
});

test("channel file routes stay inside the named root", async () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const { root, outside } = workspaceWithFiles();
  const attached = tempDir();
  writeFileSync(join(attached, "ok.md"), "ok");
  symlinkSync(outside, join(attached, "leak.txt"));
  const channel = store.createChannel(workspace.id, {
    name: "safe",
    folders: [attached],
  });
  const handler = createFileHandler(root, store);
  const folderId = basename(attached);

  const leak = await handler(
    new Request(
      `http://localhost/api/v1/channels/${channel.id}/file-roots/${folderId}/leak.txt`,
    ),
  );
  expect(leak.status).toBe(404);

  const escape = await handler(
    new Request(
      `http://localhost/api/v1/channels/${channel.id}/file-roots/${folderId}/../secret.txt`,
    ),
  );
  expect(escape.status).toBe(404);

  const otherChannel = await handler(
    new Request("http://localhost/api/v1/channels/ch_missing/files/ok.md"),
  );
  expect(otherChannel.status).toBe(404);

  store.close();
});
