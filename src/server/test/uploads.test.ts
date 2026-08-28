import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PhiStore } from "@/core/store/store";
import { uploadsPath } from "@/core/paths";
import {
  parseAttachmentHref,
  sanitizeFilename,
  attachmentApiPath,
} from "@/shared/attachments";
import {
  createAttachmentHandlers,
  parseFilenameHeader,
  resolveContentType,
  resolveUploadFile,
  writeStreamToFile,
  UploadTooLargeError,
} from "@/server/uploads";
import { tempDir } from "@/testing/tmpdir";

function fixture() {
  const root = tempDir();
  const store = new PhiStore(root);
  const handlers = createAttachmentHandlers(store, { maxBytes: 64 });
  return { root, store, handlers };
}

test("sanitizeFilename strips paths, controls, and caps length", () => {
  expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
  expect(sanitizeFilename("C:\\\\Windows\\\\x.png")).toBe("x.png");
  expect(sanitizeFilename("foo\0bar.png")).toBe("foobar.png");
  expect(sanitizeFilename("")).toBe("file");
  expect(sanitizeFilename(".")).toBe("file");
  expect(sanitizeFilename("..")).toBe("file");
  expect(sanitizeFilename("a".repeat(300) + ".png").length).toBe(255);
  expect(sanitizeFilename("a".repeat(300) + ".png").endsWith(".png")).toBe(
    true,
  );
});

test("parseAttachmentHref accepts the scheme and the API path", () => {
  const id = `att_${"a".repeat(32)}`;
  expect(parseAttachmentHref(`attachment:${id}`)).toEqual({ id });
  expect(parseAttachmentHref(attachmentApiPath(id))).toEqual({ id });
  expect(parseAttachmentHref(`http://host${attachmentApiPath(id)}`)).toEqual({
    id,
  });
  expect(parseAttachmentHref("channels/general/report.md")).toBeNull();
  expect(parseAttachmentHref("att_notanid")).toBeNull();
});

test("resolveContentType prefers a real declared type over the extension", () => {
  expect(resolveContentType("image/png; charset=binary", "notes.txt")).toBe(
    "image/png",
  );
  expect(resolveContentType("application/octet-stream", "shot.png")).toContain(
    "png",
  );
  expect(resolveContentType(undefined, "Report.PNG")).toContain("png");
  expect(resolveContentType(undefined, "file.bin")).toBe(
    "application/octet-stream",
  );
});

test("parseFilenameHeader reads Content-Disposition and X-Phi-Filename", () => {
  expect(parseFilenameHeader(null, "shot.png")).toBe("shot.png");
  expect(
    parseFilenameHeader('attachment; filename="notes.pdf"', null),
  ).toBe("notes.pdf");
  expect(
    parseFilenameHeader("attachment; filename*=UTF-8''na%C3%AFve.txt", null),
  ).toBe("naïve.txt");
  expect(parseFilenameHeader('inline; filename="../../x"', null)).toBe("x");
});

test("writeStreamToFile caps bytes and removes the partial file", async () => {
  const dir = tempDir();
  const dest = join(dir, "blob");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(40));
      controller.enqueue(new Uint8Array(40));
      controller.close();
    },
  });
  await expect(writeStreamToFile(stream, dest, 50)).rejects.toBeInstanceOf(
    UploadTooLargeError,
  );
  expect(await Bun.file(dest).exists()).toBe(false);
});

test("POST multipart stores bytes under $PHI_ROOT/uploads and returns metadata", async () => {
  const { root, store, handlers } = fixture();
  const form = new FormData();
  form.append(
    "file",
    new File(["hello phi"], "../sneaky/Report.PNG", { type: "image/png" }),
  );
  const res = await handlers.post(
    new Request("http://localhost/api/v1/attachments", {
      method: "POST",
      body: form,
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    attachment: {
      id: string;
      filename: string;
      contentType: string;
      byteSize: number;
    };
  };
  expect(body.attachment.filename).toBe("Report.PNG");
  expect(body.attachment.contentType).toBe("image/png");
  expect(body.attachment.byteSize).toBe(9);
  expect(body.attachment.id).toMatch(/^att_[a-f0-9]{32}$/);
  const stored = join(uploadsPath(root), body.attachment.id);
  expect(await Bun.file(stored).text()).toBe("hello phi");
  expect(store.getAttachment(body.attachment.id)?.filename).toBe("Report.PNG");
  store.close();
});

test("POST raw body uses X-Phi-Filename and streams to disk", async () => {
  const { root, store, handlers } = fixture();
  const res = await handlers.post(
    new Request("http://localhost/api/v1/attachments", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-phi-filename": "notes.txt",
      },
      body: "raw bytes",
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { attachment: { id: string } };
  expect(await Bun.file(join(uploadsPath(root), body.attachment.id)).text()).toBe(
    "raw bytes",
  );
  store.close();
});

test("POST rejects oversize, empty, and missing files", async () => {
  const { store, handlers } = fixture();
  const big = await handlers.post(
    new Request("http://localhost/api/v1/attachments", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "x".repeat(80),
    }),
  );
  expect(big.status).toBe(413);

  const empty = await handlers.post(
    new Request("http://localhost/api/v1/attachments", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "",
    }),
  );
  expect(empty.status).toBe(400);

  const missing = await handlers.post(
    new Request("http://localhost/api/v1/attachments", {
      method: "POST",
      body: new FormData(),
    }),
  );
  expect(missing.status).toBe(400);
  store.close();
});

test("GET serves stored bytes with nosniff and HTML CSP", async () => {
  const { store, handlers } = fixture();
  const form = new FormData();
  form.append(
    "file",
    new File(["<h1>hi</h1><script>alert(1)</script>"], "page.html", {
      type: "text/html",
    }),
  );
  const created = await handlers.post(
    new Request("http://localhost/api/v1/attachments", {
      method: "POST",
      body: form,
    }),
  );
  const { attachment } = (await created.json()) as {
    attachment: { id: string };
  };

  const res = await handlers.get(
    new Request(`http://localhost/api/v1/attachments/${attachment.id}`),
    { id: attachment.id },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("html");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toContain(
    "script-src 'none'",
  );
  expect(res.headers.get("cache-control")).toContain("private");
  expect(await res.text()).toContain("<h1>hi</h1>");

  const download = await handlers.get(
    new Request(
      `http://localhost/api/v1/attachments/${attachment.id}?download=1`,
    ),
    { id: attachment.id },
  );
  expect(download.headers.get("content-disposition")).toContain("attachment");

  const meta = await handlers.meta(
    new Request(`http://localhost/api/v1/attachments/${attachment.id}/meta`),
    { id: attachment.id },
  );
  expect(meta.status).toBe(200);
  expect(await meta.json()).toMatchObject({
    attachment: { id: attachment.id, filename: "page.html" },
  });
  store.close();
});

test("GET rejects unknown ids, traversal, and escaped symlinks", async () => {
  const { root, store, handlers } = fixture();
  expect(
    (
      await handlers.get(new Request("http://localhost/api/v1/attachments/nope"), {
        id: "nope",
      })
    ).status,
  ).toBe(404);

  const traversal = `att_${"../".repeat(8)}passwd`.slice(0, 36);
  expect(
    (
      await handlers.get(
        new Request(`http://localhost/api/v1/attachments/${traversal}`),
        { id: traversal },
      )
    ).status,
  ).toBe(404);

  const id = `att_${"b".repeat(32)}`;
  mkdirSync(uploadsPath(root), { recursive: true });
  const outside = join(root, "secret.txt");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(uploadsPath(root), id));
  store.createAttachment({
    id,
    workspaceId: store.defaultWorkspace().id,
    filename: "leak.txt",
    contentType: "text/plain",
    byteSize: 7,
  });
  expect(resolveUploadFile(root, id)).toBeNull();
  expect(
    (
      await handlers.get(
        new Request(`http://localhost/api/v1/attachments/${id}`),
        { id },
      )
    ).status,
  ).toBe(404);
  store.close();
});

test("multipart without Content-Length is still capped while streaming", async () => {
  const root = tempDir();
  const store = new PhiStore(root);
  const handlers = createAttachmentHandlers(store, {
    maxBytes: 64,
    multipartOverhead: 32,
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(200));
      controller.close();
    },
  });
  const res = await handlers.post(
    new Request("http://localhost/api/v1/attachments", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----x" },
      body: stream,
    }),
  );
  expect(res.status).toBe(413);
  store.close();
});

test("a failed oversize write leaves no leftover blob", async () => {
  const { root, store, handlers } = fixture();
  await handlers.post(
    new Request("http://localhost/api/v1/attachments", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "x".repeat(80),
    }),
  );
  const uploads = uploadsPath(root);
  mkdirSync(uploads, { recursive: true });
  const names = readdirSync(uploads).filter((name) => name !== ".tmp");
  expect(names).toEqual([]);
  store.close();
});
