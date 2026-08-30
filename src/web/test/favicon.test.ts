import { expect, test } from "bun:test";
import faviconPng from "@/web/favicon.png" with { type: "file" };
import appleTouchIcon from "@/web/apple-touch-icon.png" with { type: "file" };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

test("html shell points at the brand favicon routes", async () => {
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(html).toContain('rel="icon" href="/favicon.png"');
  expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
});

test("favicon assets are pngs derived from the brand logo", async () => {
  for (const path of [faviconPng, appleTouchIcon]) {
    const bytes = await Bun.file(path).bytes();
    expect([...bytes.slice(0, 4)]).toEqual(PNG_MAGIC);
  }
});

test("exact favicon routes beat an html catch-all", async () => {
  const png = (path: string) =>
    new Response(Bun.file(path), { headers: { "Content-Type": "image/png" } });
  const server = Bun.serve({
    port: 0,
    routes: {
      "/favicon.ico": () => png(faviconPng),
      "/favicon.png": () => png(faviconPng),
      "/apple-touch-icon.png": () => png(appleTouchIcon),
      "/*": new Response("html"),
    },
  });
  try {
    for (const path of ["/favicon.ico", "/favicon.png", "/apple-touch-icon.png"]) {
      const response = await fetch(new URL(path, server.url));
      expect(response.ok).toBe(true);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect([
        ...new Uint8Array(await response.arrayBuffer()).slice(0, 4),
      ]).toEqual(PNG_MAGIC);
    }
  } finally {
    server.stop(true);
  }
});
