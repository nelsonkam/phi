import { expect, test } from "bun:test";
import { serverAddress } from "@/server/serve";

test("server address defaults to loopback and accepts sandbox overrides", () => {
  expect(serverAddress({})).toEqual({ host: "127.0.0.1", port: 3141 });
  expect(
    serverAddress({ PHI_HOST: "0.0.0.0", PHI_PORT: "43141" }),
  ).toEqual({ host: "0.0.0.0", port: 43141 });
});
