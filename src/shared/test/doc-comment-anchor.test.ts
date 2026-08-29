import { expect, test } from "bun:test";
import { captureTextQuote, locateTextQuote, snapSelectionToWords } from "@/shared/doc-comment-anchor";

test("formatted-span selections round-trip through concatenated projection text", () => {
  const projection = "The quick brown fox jumps";
  // "quick br" spans the boundary between "quick" and " brown"
  const quote = captureTextQuote(projection, 4, 12);
  expect(quote).toEqual({
    quote: "quick br",
    prefix: "The ",
    suffix: "own fox jumps",
  });
  expect(locateTextQuote(projection, quote.quote, quote.prefix, quote.suffix)).toEqual({
    start: 4,
    end: 12,
  });
});

test("duplicate quotes are disambiguated by prefix and suffix", () => {
  const text = "alpha repeat mid repeat omega";
  const first = captureTextQuote(text, 6, 12);
  const second = captureTextQuote(text, 17, 23);
  expect(first.quote).toBe("repeat");
  expect(second.quote).toBe("repeat");
  expect(locateTextQuote(text, first.quote, first.prefix, first.suffix)).toEqual({
    start: 6,
    end: 12,
  });
  expect(locateTextQuote(text, second.quote, second.prefix, second.suffix)).toEqual({
    start: 17,
    end: 23,
  });
});

test("whitespace-collapsed matching still finds the quote", () => {
  const original = "Hello   world\nthere";
  const quote = "Hello world";
  const match = locateTextQuote(original, quote, "", " there");
  expect(match).toEqual({ start: 0, end: 13 });
});

test("a missing quote is detached, then reattaches when restored", () => {
  const quote = "unique phrase";
  const prefix = "before ";
  const suffix = " after";
  expect(locateTextQuote("something else entirely", quote, prefix, suffix)).toBeNull();
  expect(
    locateTextQuote("before unique phrase after", quote, prefix, suffix),
  ).toEqual({ start: 7, end: 20 });
});

test("partial-word selections snap out to word boundaries", () => {
  expect(snapSelectionToWords("worker fleet. Burrow", 14, 17)).toEqual({
    start: 14,
    end: 20,
  });
  expect(snapSelectionToWords("The unique phrase", 6, 10)).toEqual({
    start: 4,
    end: 10,
  });
});
