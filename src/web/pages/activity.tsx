import { useNavigate } from "react-router";
import { CheckCheck, LoaderCircle, RotateCcw } from "lucide-react";
import type { ActivityItem } from "@/shared/types";
import { AuthorAvatar, authorLabel } from "@/web/components/message";
import {
  useActivity,
  useMarkAllRead,
  useRetryTurn,
  useThreadTurn,
} from "@/web/lib/queries";
import { relativeTime } from "@/web/lib/time";
import { cn } from "@/web/lib/utils";
import { EmptyState, Page } from "../app";

// The user's queue, Slack-Activity style: one reverse-chronological list of
// threads by latest message. Read state changes styling, never membership.
export function ActivityPage() {
  const { data, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useActivity();
  const markAllRead = useMarkAllRead();
  const items = data?.pages.flatMap((page) => page.activity) ?? [];
  const unreadThreadIds = items
    .filter((item) => item.unreadCount > 0)
    .map((item) => item.thread.id);

  return (
    <Page
      title="Activity"
      titleExtra={
        unreadThreadIds.length > 0 ? (
          <button
            type="button"
            onClick={() => markAllRead.mutate(unreadThreadIds)}
            disabled={markAllRead.isPending}
            className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <CheckCheck className="size-3.5" />
            Mark all read
          </button>
        ) : null
      }
    >
      {!isPending && items.length === 0 ? (
        <EmptyState message="Nothing here yet. Start a thread in a channel." />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl py-2">
            {items.map((item) => (
              <ActivityRow key={item.thread.id} item={item} />
            ))}
            {hasNextPage && (
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="mx-5 my-2 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
              >
                {isFetchingNextPage ? "Loading…" : "Show older"}
              </button>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const { thread, channelName, latestMessage, unreadCount } = item;
  const navigate = useNavigate();
  const liveTurn = useThreadTurn(thread.id);
  const persistedAgent = thread.turnActive ? (thread.turnAgent ?? "agent") : null;
  const workingAgent = liveTurn.ready ? liveTurn.agent : persistedAgent;
  const isError = !workingAgent && latestMessage.kind === "error";
  const unread = unreadCount > 0;

  return (
    <div
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        navigate(`/c/${thread.channelId}/t/${thread.id}`);
      }}
      className="group flex cursor-pointer gap-3 px-5 py-3 transition-colors hover:bg-accent/40"
    >
      <AuthorAvatar message={latestMessage} />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            # {channelName}
          </span>
          {thread.title && (
            <span className="truncate text-sm font-semibold">
              {thread.title}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {relativeTime(latestMessage.createdAt)}
          </span>
          {unread && (
            <span className="ml-auto rounded-full bg-sky-600 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">
              {unreadCount}
            </span>
          )}
        </p>
        <p
          className={cn(
            "line-clamp-2 text-sm break-words",
            unread ? "font-medium" : "text-muted-foreground",
            isError && "text-destructive",
          )}
        >
          <span className={cn("font-semibold", !unread && "text-foreground")}>
            {authorLabel(latestMessage)}:
          </span>{" "}
          {latestMessage.content}
        </p>
        {workingAgent && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
            <span className="font-medium text-foreground">{workingAgent}</span>
            <span className="working-shimmer">is working...</span>
          </p>
        )}
        {isError && <RetryButton threadId={thread.id} />}
      </div>
    </div>
  );
}

// Same recovery affordance as the thread panel's: re-runs the thread's last
// user message. The resulting turn frames refresh the feed over the socket.
function RetryButton({ threadId }: { threadId: string }) {
  const retry = useRetryTurn(threadId);
  return (
    <button
      type="button"
      onClick={() => retry.mutate()}
      disabled={retry.isPending}
      className="mt-1.5 flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
    >
      <RotateCcw className="size-3" />
      Retry
    </button>
  );
}
