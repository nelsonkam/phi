import { test, expect } from "bun:test";
import {
  acpClientCapabilities,
  detectHarnesses,
  harnessEntry,
  KNOWN_HARNESSES,
} from "../harnesses";

test("detects every known harness with an install state and hint", () => {
  const statuses = detectHarnesses();
  expect(statuses.map((s) => s.id)).toEqual([...KNOWN_HARNESSES]);
  for (const status of statuses) {
    expect(typeof status.installed).toBe("boolean");
    expect(status.name.length).toBeGreaterThan(0);
    expect(status.installHint.length).toBeGreaterThan(0);
  }
});

test("launches Cursor ACP with repeated additional directory flags", () => {
  expect(harnessEntry("cursor")!.acpCommand!(["/projects/app", "/projects/docs"])).toEqual([
    "cursor-agent",
    "--add-dir",
    "/projects/app",
    "--add-dir",
    "/projects/docs",
    "acp",
  ]);
});

test("advertises parameterized model picker only for Cursor", () => {
  expect(acpClientCapabilities("cursor")).toEqual({
    fs: { readTextFile: false, writeTextFile: false },
    _meta: { parameterizedModelPicker: true },
  });
  expect(acpClientCapabilities("codex")).toEqual({
    fs: { readTextFile: false, writeTextFile: false },
  });
  expect(acpClientCapabilities("claude-code")).toEqual({
    fs: { readTextFile: false, writeTextFile: false },
  });
});
