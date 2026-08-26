import { test, expect } from "bun:test";
import { detectHarnesses, KNOWN_HARNESSES } from "../harnesses";

test("detects every known harness with an install state and hint", () => {
  const statuses = detectHarnesses();
  expect(statuses.map((s) => s.id)).toEqual([...KNOWN_HARNESSES]);
  for (const status of statuses) {
    expect(typeof status.installed).toBe("boolean");
    expect(status.name.length).toBeGreaterThan(0);
    expect(status.installHint.length).toBeGreaterThan(0);
  }
});
