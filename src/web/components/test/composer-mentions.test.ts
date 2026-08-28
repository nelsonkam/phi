import { expect, test } from "bun:test";
import { mentionTokenAtCaret } from "@/web/components/composer";

test("leading mode only matches an @ at the start of the composer", () => {
  expect(mentionTokenAtCaret("@cod", 4, "leading")).toEqual({
    start: 0,
    query: "cod",
  });
  expect(mentionTokenAtCaret("  @def", 6, "leading")).toEqual({
    start: 2,
    query: "def",
  });
  expect(mentionTokenAtCaret("please @cod", "please @cod".length, "leading")).toBeNull();
  expect(mentionTokenAtCaret("@cod more", "@cod more".length, "leading")).toBeNull();
});

test("anywhere mode matches an @ after whitespace or an opening bracket", () => {
  const body = "please @cod";
  expect(mentionTokenAtCaret(body, body.length, "anywhere")).toEqual({
    start: body.lastIndexOf("@"),
    query: "cod",
  });
  const punct = "Add a comment — @gro";
  expect(mentionTokenAtCaret(punct, punct.length, "anywhere")).toEqual({
    start: punct.lastIndexOf("@"),
    query: "gro",
  });
  expect(mentionTokenAtCaret("see (@cod", 9, "anywhere")).toEqual({
    start: 5,
    query: "cod",
  });
  expect(mentionTokenAtCaret("user@example", 12, "anywhere")).toBeNull();
  expect(mentionTokenAtCaret("cc:@cod", 7, "anywhere")).toBeNull();
  expect(mentionTokenAtCaret("@", 1, "anywhere")).toEqual({
    start: 0,
    query: "",
  });
});
