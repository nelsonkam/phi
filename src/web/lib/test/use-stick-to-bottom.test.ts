import { expect, test } from "bun:test";
import {
  followContainerShrink,
  followContentHeight,
} from "@/web/lib/use-stick-to-bottom";

test("growing content sticks while pinned and raises hasNew when not", () => {
  expect(followContentHeight(100, 140, true)).toBe("stick");
  expect(followContentHeight(100, 140, false)).toBe("hasNew");
});

test("shrinking or unchanged content is ignored", () => {
  expect(followContentHeight(140, 100, true)).toBe("ignore");
  expect(followContentHeight(140, 140, true)).toBe("ignore");
  expect(followContentHeight(140, 100, false)).toBe("ignore");
});

test("a shrinking viewport sticks while pinned and otherwise stays put", () => {
  expect(followContainerShrink(400, 280, true)).toBe("stick");
  expect(followContainerShrink(400, 280, false)).toBe("ignore");
  expect(followContainerShrink(280, 400, true)).toBe("ignore");
  expect(followContainerShrink(280, 280, true)).toBe("ignore");
});
