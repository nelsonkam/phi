// Text-quote anchors for doc comments. Matching runs against a canonical
// rendered-text projection (concatenated visible text), never raw markdown.

export const ANCHOR_CONTEXT_CHARS = 32;
export const MAX_QUOTE_CHARS = 4000;
export const MAX_AFFIX_CHARS = 64;
export const MAX_HEADING_SLUG_CHARS = 200;

export interface TextQuote {
  quote: string;
  prefix: string;
  suffix: string;
}

export interface AnchorMatch {
  start: number;
  end: number;
}

export function captureTextQuote(
  text: string,
  start: number,
  end: number,
): TextQuote {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(from, Math.max(start, end));
  return {
    quote: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - ANCHOR_CONTEXT_CHARS), from),
    suffix: text.slice(to, to + ANCHOR_CONTEXT_CHARS),
  };
}

export function snapSelectionToWords(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let from = Math.max(0, Math.min(start, end));
  let to = Math.max(from, Math.max(start, end));
  while (from > 0 && isWordChar(text[from]) && isWordChar(text[from - 1])) {
    from--;
  }
  while (to < text.length && isWordChar(text[to - 1]) && isWordChar(text[to])) {
    to++;
  }
  while (from < to && /\s/.test(text[from]!)) from++;
  while (to > from && /\s/.test(text[to - 1]!)) to--;
  return { start: from, end: to };
}

function isWordChar(ch: string | undefined): boolean {
  return Boolean(ch && /[\p{L}\p{N}_]/u.test(ch));
}

// Exact quote, then prefix/suffix to pick among repeats, then a whitespace-
// collapsed search. Returns null when the quote is gone (detached).
export function locateTextQuote(
  text: string,
  quote: string,
  prefix: string,
  suffix: string,
): AnchorMatch | null {
  if (!quote) return null;
  const exact = bestOccurrence(text, quote, prefix, suffix);
  if (exact) return exact;
  return locateCollapsed(text, quote, prefix, suffix);
}

function bestOccurrence(
  text: string,
  quote: string,
  prefix: string,
  suffix: string,
): AnchorMatch | null {
  const starts = allIndexes(text, quote);
  if (starts.length === 0) return null;
  if (starts.length === 1) {
    const start = starts[0]!;
    return { start, end: start + quote.length };
  }
  let best: { start: number; score: number } | null = null;
  for (const start of starts) {
    const score = contextScore(text, start, quote.length, prefix, suffix);
    if (!best || score > best.score) best = { start, score };
  }
  const start = best!.start;
  return { start, end: start + quote.length };
}

function contextScore(
  text: string,
  start: number,
  quoteLen: number,
  prefix: string,
  suffix: string,
): number {
  const before = text.slice(Math.max(0, start - prefix.length), start);
  const after = text.slice(start + quoteLen, start + quoteLen + suffix.length);
  let score = 0;
  if (prefix && before.endsWith(prefix)) score += 2;
  else if (prefix && before === prefix.slice(-before.length)) score += 1;
  if (suffix && after.startsWith(suffix)) score += 2;
  else if (suffix && after === suffix.slice(0, after.length)) score += 1;
  return score;
}

function locateCollapsed(
  text: string,
  quote: string,
  prefix: string,
  suffix: string,
): AnchorMatch | null {
  const { collapsed, map } = collapseWithMap(text);
  const collapsedQuote = collapseWs(quote);
  if (!collapsedQuote) return null;
  const match = bestOccurrence(
    collapsed,
    collapsedQuote,
    collapseWs(prefix),
    collapseWs(suffix),
  );
  if (!match) return null;
  const start = map[match.start] ?? text.length;
  const end =
    match.end >= map.length
      ? text.length
      : (map[match.end] ?? text.length);
  if (end <= start) return null;
  return { start, end };
}

function collapseWs(value: string): string {
  return value.replace(/\s+/g, " ");
}

function collapseWithMap(original: string): {
  collapsed: string;
  map: number[];
} {
  const chars: string[] = [];
  const map: number[] = [];
  let i = 0;
  while (i < original.length) {
    if (/\s/.test(original[i]!)) {
      const start = i;
      while (i < original.length && /\s/.test(original[i]!)) i++;
      chars.push(" ");
      map.push(start);
    } else {
      chars.push(original[i]!);
      map.push(i);
      i++;
    }
  }
  return { collapsed: chars.join(""), map };
}

function allIndexes(text: string, quote: string): number[] {
  const hits: number[] = [];
  let from = 0;
  while (from <= text.length - quote.length) {
    const at = text.indexOf(quote, from);
    if (at < 0) break;
    hits.push(at);
    from = at + 1;
  }
  return hits;
}
