import { expect, test } from "bun:test";
import { formatTurnElapsed } from "@/web/lib/time";

test("formatTurnElapsed hides sub-second and then counts up", () => {
  expect(formatTurnElapsed(0)).toBeNull();
  expect(formatTurnElapsed(999)).toBeNull();
  expect(formatTurnElapsed(1000)).toBe("1s");
  expect(formatTurnElapsed(42_000)).toBe("42s");
  expect(formatTurnElapsed(65_000)).toBe("1m 05s");
  expect(formatTurnElapsed(3_600_000)).toBe("1h 00m");
  expect(formatTurnElapsed(3_721_000)).toBe("1h 02m");
});
