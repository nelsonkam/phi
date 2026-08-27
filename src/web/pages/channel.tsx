import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { LoaderCircle, MessageSquareText } from "lucide-react";
import type { ThreadSummary } from "@/shared/types";
import { Composer } from "@/web/components/composer";
import { JumpToLatest } from "@/web/components/jump-to-latest";
import { MessageItem } from "@/web/components/message";
import { ThreadPanel } from "@/web/components/thread-panel";
import {
  useAgents,
  useChannels,
  useCreateThread,
  useThreadTurn,
  useThreads,
} from "@/web/lib/queries";
import { threadUntaggedAgent } from "@/web/lib/thread-agent";
import {
  isThreadWorking,
  threadAttention,
  type ThreadAttention,
} from "@/web/lib/thread-status";
import { relativeTime } from "@/web/lib/time";
import { useStickToBottom } from "@/web/lib/use-stick-to-bottom";
import { EmptyState, Page } from "../app";

// Slack-style channel: a chronological flow of thread root messages, with
// the thread detail opening in a side panel.
export function ChannelPage() {
  const { channelId = "", threadId } = useParams();
  const navigate = useNavigate();
  const { data: channelData } = useChannels();
  const { data: agentData } = useAgents();
  const channel = channelData?.channels.find((c) => c.id === channelId);
  const untaggedAgent = threadUntaggedAgent(null, agentData?.agents);
  const { data, isPending } = useThreads(channelId);
  const create = useCreateThread(channelId);
  const selectedThread = data?.threads.find((thread) => thread.id === threadId);

  // The flow reads oldest-first by root message; replies bump a thread's
  // activity but never move it in the flow.
  const threads = useMemo(
    () =>
      [...(data?.threads ?? [])].sort(
        (a, b) => (a.rootMessage?.seq ?? 0) - (b.rootMessage?.seq ?? 0),
      ),
    [data?.threads],
  );

  const { scrollProps, pinned, hasNew, scrollToBottom } = useStickToBottom(
    threads.length,
    channelId,
  );

  async function startThread(content: string) {
    const { thread } = await create.mutateAsync(content);
    navigate(`/c/${channelId}/t/${thread.id}`);
  }

  return (
    <Page
      title={channel ? `# ${channel.name}` : "…"}
      titleExtra={
        untaggedAgent ? (
          <Link
            to={`/agents/${untaggedAgent}`}
            title="Answers messages that do not start with @name"
            className="mention shrink-0 text-[11px] leading-5"
          >
            @{untaggedAgent}
          </Link>
        ) : null
      }
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <div
              {...scrollProps}
              className="flex h-full flex-col overflow-y-auto"
            >
              {!isPending && threads.length === 0 ? (
                <EmptyState message="No messages yet. Say something below." />
              ) : (
                <div className="mt-auto py-3">
                  {threads.map((thread) => (
                    <ThreadRoot
                      key={thread.id}
                      thread={thread}
                      active={thread.id === threadId}
                      onOpen={() => navigate(`/c/${channelId}/t/${thread.id}`)}
                    />
                  ))}
                </div>
              )}
            </div>
            {!pinned && (
              <JumpToLatest hasNew={hasNew} onClick={() => scrollToBottom()} />
            )}
          </div>
          <Composer
            placeholder={`Message #${channel?.name ?? ""}`}
            disabled={create.isPending}
            draftKey={`channel:${channelId}`}
            onSend={(content) => void startThread(content)}
          />
        </div>

        {threadId && (
          <ThreadPanel
            key={threadId}
            channelId={channelId}
            channelName={channel?.name}
            threadId={threadId}
            turnActive={selectedThread?.turnActive ?? false}
            turnAgent={selectedThread?.turnAgent ?? null}
          />
        )}
      </div>
    </Page>
  );
}

function ThreadRoot({
  thread,
  active,
  onOpen,
}: {
  thread: ThreadSummary;
  active: boolean;
  onOpen: () => void;
}) {
  const liveTurn = useThreadTurn(thread.id);
  const working = isThreadWorking(liveTurn, thread.turnActive);
  const attention = threadAttention(
    working,
    thread.latestMessage?.author ?? thread.rootMessage?.author,
    thread.unreadCount,
  );
  const replies = thread.messageCount - 1;
  if (!thread.rootMessage) return null;

  return (
    <div
      onClick={(e) => {
        // Markdown bodies contain their own interactive elements (links, the
        // code-header copy button); those clicks must not also open the thread.
        if ((e.target as HTMLElement).closest("a, button")) return;
        onOpen();
      }}
      className={`group cursor-pointer px-5 py-2 transition-colors ${
        active ? "bg-foreground/10" : "hover:bg-accent/40"
      }`}
    >
      <MessageItem message={thread.rootMessage}>
        {(replies > 0 || attention) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="mt-1.5 flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 -ml-1.5 text-xs font-medium text-sky-600 transition-colors group-hover:border-border group-hover:bg-background dark:text-sky-400"
          >
            {replies > 0 && (
              <>
                <MessageSquareText className="size-3.5" />
                {replies} {replies === 1 ? "reply" : "replies"}
                <span className="font-normal text-muted-foreground">
                  · last {relativeTime(thread.updatedAt)}
                </span>
              </>
            )}
            <ThreadAttentionMark attention={attention} />
            {replies === 0 && attention === "working" && (
              <span aria-hidden="true">working</span>
            )}
          </button>
        )}
      </MessageItem>
    </div>
  );
}

function ThreadAttentionMark({ attention }: { attention: ThreadAttention }) {
  if (!attention) return null;
  if (attention === "working") {
    return (
      <span
        role="img"
        aria-label="Working"
        title="Working"
        className="inline-flex"
      >
        <LoaderCircle className="size-3 shrink-0 animate-spin text-sky-600 dark:text-sky-400" />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label="Waiting for a response"
      title="Waiting for a response"
      className="size-2 shrink-0 rounded-full bg-sky-600 dark:bg-sky-400"
    />
  );
}
