import { expect, test } from "bun:test";
import { followContentHeight } from "@/web/lib/use-stick-to-bottom";

test("growing content sticks while pinned and raises hasNew when not", () => {
  expect(followContentHeight(100, 140, true)).toBe("stick");
  expect(followContentHeight(100, 140, false)).toBe("hasNew");
});

test("shrinking or unchanged content is ignored", () => {
  expect(followContentHeight(140, 100, true)).toBe("ignore");
  expect(followContentHeight(140, 140, true)).toBe("ignore");
  expect(followContentHeight(140, 100, false)).toBe("ignore");
});
