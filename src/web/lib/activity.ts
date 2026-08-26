import type { ActivityItem, Message } from "@/shared/types";

// Client page size for the activity feed; requested explicitly so the
// cursor logic below stays in lockstep with what the server returned.
export const ACTIVITY_PAGE_SIZE = 50;

// A short page means the feed is exhausted; only a full page earns a
// cursor, so "Show older" never dangles after the last real page.
export function activityNextCursor(page: {
  activity: ActivityItem[];
}): number | undefined {
  return page.activity.length >= ACTIVITY_PAGE_SIZE
    ? page.activity.at(-1)!.latestMessage.seq
    : undefined;
}

// Flattens markdown to plain text for one-line feed excerpts: links and
// images keep their label, emphasis/code markers and structural prefixes
// drop, whitespace collapses. Not a parser — just enough that a row never
// shows raw `**` or `](...)`.
export function excerptText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)/gm, "")
    .replace(/(\*\*|__|[*_~])/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// The read watermark must re-advance once per *committed* message.
// Optimistic sends predict their seq (last + 1) and the committed row can
// land on that same value, so keying an effect on seq can miss the commit
// entirely; ids never collide, and optimistic rows are excluded so the
// effect fires again when the real row replaces one.
export function latestCommittedMessageId(
  messages: Message[],
): string | undefined {
  return messages.findLast((m) => m.metadata.optimistic !== true)?.id;
}
