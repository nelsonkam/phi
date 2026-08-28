import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { DeviceAuth, DEVICE_COOKIE, requireDeviceAuth, sessionResponse } from "@/server/device-auth";
import { deviceTokenPath } from "@/core/paths";
import { PhiStore } from "@/core/store/store";
import { createAttachmentHandlers } from "@/server/uploads";
import { tempDir } from "@/testing/tmpdir";

function authFixture() {
  const root = tempDir();
  const store = new PhiStore(root);
  const auth = new DeviceAuth(root);
  const handlers = createAttachmentHandlers(store, { maxBytes: 64 });
  return { root, store, auth, handlers };
}

function authed(auth: DeviceAuth, url: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${auth.localToken}`);
  return new Request(url, { ...init, headers });
}

test("mints a 0600 device-token file and accepts Bearer and cookie", () => {
  const { root, auth, store } = authFixture();
  const path = deviceTokenPath(root);
  expect(readFileSync(path, "utf8").trim()).toBe(auth.localToken);
  expect(statSync(path).mode & 0o777).toBe(0o600);

  const bearer = new Request("http://localhost/api/v1/attachments", {
    headers: { authorization: `Bearer ${auth.localToken}` },
  });
  expect(auth.authorize(bearer)).toBe(true);

  const cookie = new Request("http://localhost/api/v1/attachments", {
    headers: { cookie: `${DEVICE_COOKIE}=${auth.localToken}` },
  });
  expect(auth.authorize(cookie)).toBe(true);

  expect(auth.authorize(new Request("http://localhost/api/v1/attachments"))).toBe(
    false,
  );
  expect(
    auth.authorize(
      new Request("http://localhost/api/v1/attachments", {
        headers: { authorization: `Bearer ${crypto.randomUUID()}` },
      }),
    ),
  ).toBe(false);
  store.close();
});

test("reuses the existing token file and ignores a corrupt extra cookie", () => {
  const { root, auth, store } = authFixture();
  const again = new DeviceAuth(root);
  expect(again.localToken).toBe(auth.localToken);
  expect(
    auth.authorize(
      new Request("http://localhost/x", {
        headers: { cookie: `other=${auth.localToken}; ${DEVICE_COOKIE}=nope` },
      }),
    ),
  ).toBe(false);
  store.close();
});

test("session issues a cookie on loopback and 401s remotely without credentials", async () => {
  const { auth, store } = authFixture();
  const missing = new Request("http://localhost/api/v1/auth/session");
  const loopback = sessionResponse(auth, missing, true);
  expect(loopback.status).toBe(200);
  expect(loopback.headers.get("set-cookie")).toContain(`${DEVICE_COOKIE}=${auth.localToken}`);

  const remote = sessionResponse(auth, missing, false);
  expect(remote.status).toBe(401);
  expect(remote.headers.get("www-authenticate")).toContain("Bearer");

  const already = sessionResponse(
    auth,
    new Request("http://localhost/api/v1/auth/session", {
      headers: { authorization: `Bearer ${auth.localToken}` },
    }),
    false,
  );
  expect(already.status).toBe(200);
  expect(already.headers.get("set-cookie")).toBeNull();
  store.close();
});

test("attachment POST/GET/meta reject missing credentials and accept Bearer", async () => {
  const { auth, handlers, store } = authFixture();
  const form = new FormData();
  form.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));

  const deniedPost = requireDeviceAuth(
    auth,
    new Request("http://localhost/api/v1/attachments", {
      method: "POST",
      body: form,
    }),
  );
  expect(deniedPost?.status).toBe(401);

  const created = await handlers.post(
    authed(auth, "http://localhost/api/v1/attachments", {
      method: "POST",
      body: form,
    }),
  );
  expect(created.status).toBe(201);
  const { attachment } = (await created.json()) as {
    attachment: { id: string };
  };

  expect(
    requireDeviceAuth(
      auth,
      new Request(`http://localhost/api/v1/attachments/${attachment.id}`),
    )?.status,
  ).toBe(401);
  expect(
    requireDeviceAuth(
      auth,
      new Request(`http://localhost/api/v1/attachments/${attachment.id}/meta`),
    )?.status,
  ).toBe(401);

  const get = await handlers.get(
    authed(auth, `http://localhost/api/v1/attachments/${attachment.id}`),
    { id: attachment.id },
  );
  expect(get.status).toBe(200);
  expect(await get.text()).toBe("hello");

  const meta = await handlers.meta(
    authed(auth, `http://localhost/api/v1/attachments/${attachment.id}/meta`),
    { id: attachment.id },
  );
  expect(meta.status).toBe(200);
  store.close();
});
