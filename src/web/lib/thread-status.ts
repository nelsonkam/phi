import type { MessageAuthor } from "@/shared/types";

export type ThreadAttention = "working" | "waiting" | null;

// Live turn frames are the source of truth once the hello/presence cache is
// ready; until then, fall back to the persisted thread flag.
export function isThreadWorking(
  live: { ready: boolean; agent: string | null },
  persistedActive: boolean,
): boolean {
  return live.ready ? live.agent !== null : persistedActive;
}

// Working wins. Waiting means an agent replied and the user hasn't seen it
// yet — the read watermark clears the dot the moment the thread is opened,
// so no time-based decay is needed.
export function threadAttention(
  working: boolean,
  latestAuthor: MessageAuthor | null | undefined,
  unreadCount: number,
): ThreadAttention {
  if (working) return "working";
  if (latestAuthor === "agent" && unreadCount > 0) return "waiting";
  return null;
}
