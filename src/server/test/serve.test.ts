import { expect, test } from "bun:test";
import {
  reflectionIntervalMs,
  reflectionTaskDefinition,
  serverAddress,
} from "@/server/serve";

test("server address defaults to loopback and accepts sandbox overrides", () => {
  expect(serverAddress({})).toEqual({ host: "127.0.0.1", port: 3141 });
  expect(
    serverAddress({ PHI_HOST: "0.0.0.0", PHI_PORT: "43141" }),
  ).toEqual({ host: "0.0.0.0", port: 43141 });
});

test("reflection interval treats blank and invalid values as the default", () => {
  expect(reflectionIntervalMs({})).toBeUndefined();
  expect(reflectionIntervalMs({ PHI_REFLECTION_INTERVAL_MS: "" })).toBeUndefined();
  expect(reflectionIntervalMs({ PHI_REFLECTION_INTERVAL_MS: "nope" })).toBeUndefined();
  expect(reflectionIntervalMs({ PHI_REFLECTION_INTERVAL_MS: "-1" })).toBeUndefined();
  expect(reflectionIntervalMs({ PHI_REFLECTION_INTERVAL_MS: "0" })).toBe(0);
  expect(reflectionIntervalMs({ PHI_REFLECTION_INTERVAL_MS: "60000" })).toBe(
    60_000,
  );
});

test("reflection registers as a cron task with interval compatibility", () => {
  expect(reflectionTaskDefinition({})).toMatchObject({
    id: "system.reflection",
    handler: "reflection",
    schedule: { kind: "cron", expression: "0 3 * * *" },
    catchUp: "run_once",
    initialRun: "now",
  });
  expect(
    reflectionTaskDefinition({
      PHI_REFLECTION_CRON: "0 4 * * MON",
      PHI_REFLECTION_TIMEZONE: "America/Toronto",
    }),
  ).toMatchObject({
    schedule: {
      kind: "cron",
      expression: "0 4 * * MON",
      timezone: "America/Toronto",
    },
  });
  expect(
    reflectionTaskDefinition({ PHI_REFLECTION_INTERVAL_MS: "60000" }),
  ).toMatchObject({
    schedule: { kind: "interval", everyMs: 60_000 },
    enabled: true,
  });
  expect(
    reflectionTaskDefinition({ PHI_REFLECTION_INTERVAL_MS: "0" }),
  ).toMatchObject({ enabled: false });
});
