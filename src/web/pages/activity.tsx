import { useNavigate, useParams } from "react-router";
import { CheckCheck, LoaderCircle, RotateCcw } from "lucide-react";
import type { ActivityItem } from "@/shared/types";
import { AuthorAvatar, authorLabel } from "@/web/components/message";
import { ThreadPanel } from "@/web/components/thread-panel";
import { excerptText } from "@/web/lib/activity";
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
// Clicking a row opens the thread in a side panel (route /t/:threadId) so
// moving between threads never leaves the queue.
export function ActivityPage() {
  const { threadId } = useParams();
  const { data, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useActivity();
  const markAllRead = useMarkAllRead();
  const items = data?.pages.flatMap((page) => page.activity) ?? [];
  const hasUnread = items.some((item) => item.unreadCount > 0);
  const selected = items.find((item) => item.thread.id === threadId);

  return (
    <Page
      title="Activity"
      titleExtra={
        hasUnread ? (
          <button
            type="button"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
            className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <CheckCheck className="size-3.5" />
            Mark all read
          </button>
        ) : null
      }
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {!isPending && items.length === 0 ? (
            <EmptyState message="Nothing here yet. Start a thread in a channel." />
          ) : (
            <div className="mx-auto max-w-2xl py-2">
              {items.map((item) => (
                <ActivityRow
                  key={item.thread.id}
                  item={item}
                  selected={item.thread.id === threadId}
                />
              ))}
              {hasNextPage && (
                <button
                  type="button"
                  onClick={() => void fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="mx-4 my-2 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
                >
                  {isFetchingNextPage ? "Loading…" : "Show older"}
                </button>
              )}
            </div>
          )}
        </div>

        {threadId && (
          <ThreadPanel
            key={threadId}
            channelId={selected?.thread.channelId ?? ""}
            channelName={selected?.channelName}
            threadId={threadId}
            turnActive={selected?.thread.turnActive ?? false}
            turnAgent={selected?.thread.turnAgent ?? null}
            closeTo="/"
          />
        )}
      </div>
    </Page>
  );
}

// Row anatomy: title leads, a right rail carries time and the unread count,
// and one metadata line compresses channel + author + excerpt. Working and
// error states get a line only when present, so quiet rows stay two lines.
function ActivityRow({
  item,
  selected,
}: {
  item: ActivityItem;
  selected: boolean;
}) {
  const { thread, channelName, latestMessage, unreadCount } = item;
  const navigate = useNavigate();
  const liveTurn = useThreadTurn(thread.id);
  const persistedAgent = thread.turnActive ? (thread.turnAgent ?? "agent") : null;
  const workingAgent = liveTurn.ready ? liveTurn.agent : persistedAgent;
  const isError = !workingAgent && latestMessage.kind === "error";
  const unread = unreadCount > 0;
  const excerpt = excerptText(latestMessage.content);
  const title = thread.title ? excerptText(thread.title) : excerpt;
  // A one-message thread's latest message IS the title; repeating it as the
  // excerpt says nothing, so the meta line keeps just channel + author. The
  // store ellipsizes long titles, so compare against the pre-… base.
  const repeatsTitle = excerpt.startsWith(title.replace(/…$/, ""));

  // Not an <a>: the row nests its own interactive elements (Retry), so it
  // gets link semantics by hand instead.
  const open = () => navigate(`/t/${thread.id}`);
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Open thread in #${channelName}: ${title}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        open();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        open();
      }}
      className={cn(
        "group flex cursor-pointer gap-3 px-4 py-2.5 transition-colors focus-visible:outline-none",
        selected
          ? "bg-foreground/10"
          : "hover:bg-accent/40 focus-visible:bg-accent/40",
      )}
    >
      <AuthorAvatar message={latestMessage} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <p
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              unread ? "font-semibold" : "font-medium",
            )}
          >
            {title}
          </p>
          <span
            className={cn(
              "shrink-0 text-xs tabular-nums",
              unread ? "font-medium text-sky-600 dark:text-sky-400" : "text-muted-foreground",
            )}
          >
            {relativeTime(latestMessage.createdAt)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <p
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              unread ? "text-foreground/80" : "text-muted-foreground",
              isError && "text-destructive",
            )}
          >
            <span className="text-muted-foreground"># {channelName}</span>
            <span className="mx-1.5 text-muted-foreground/60">·</span>
            <span className={cn(unread && "font-medium")}>
              {authorLabel(latestMessage)}
              {repeatsTitle ? "" : ":"}
            </span>
            {repeatsTitle ? "" : ` ${excerpt}`}
          </p>
          {unread && (
            <span className="shrink-0 rounded-full bg-sky-600 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">
              {unreadCount}
            </span>
          )}
        </div>
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
