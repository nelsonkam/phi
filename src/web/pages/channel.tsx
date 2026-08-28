import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { FileText, LoaderCircle, MessageSquareText } from "lucide-react";
import type { ThreadSummary } from "@/shared/types";
import { Composer } from "@/web/components/composer";
import { shouldOpenChannelThreadPanel, docCommentDeepLink } from "@/web/components/doc-comments";
import { FileViewerDialog } from "@/web/components/file-link";
import { JumpToLatest } from "@/web/components/jump-to-latest";
import { MessageItem } from "@/web/components/message";
import { ThreadPanel } from "@/web/components/thread-panel";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/web/components/ui/popover";
import {
  useAgents,
  useChannels,
  useCreateThread,
  useDocCommentSummary,
  useThread,
  useThreadTurn,
  useThreads,
} from "@/web/lib/queries";
import { workspaceFileUrl } from "@/web/lib/file-links";
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
  const { channelId = "", threadId, docThreadId } = useParams();
  const navigate = useNavigate();
  const { data: channelData } = useChannels();
  const { data: agentData } = useAgents();
  const channel = channelData?.channels.find((c) => c.id === channelId);
  const untaggedAgent = threadUntaggedAgent(null, agentData?.agents);
  const { data, isPending } = useThreads(channelId);
  const create = useCreateThread(channelId);
  const selectedThread = data?.threads.find((thread) => thread.id === threadId);
  const openPanel = shouldOpenChannelThreadPanel(
    threadId,
    data?.threads.map((thread) => thread.id),
  );
  const { data: urlThread } = useThread(
    threadId && !isPending && !selectedThread ? threadId : undefined,
  );
  const { data: docThread } = useThread(docThreadId);
  const deepLink = docCommentDeepLink(
    channelId,
    docThreadId ? "doc" : "thread",
    (docThreadId ? docThread?.thread : urlThread?.thread) ?? null,
  );

  useEffect(() => {
    if (deepLink) navigate(deepLink, { replace: true });
  }, [deepLink, navigate]);

  const [browseFile, setBrowseFile] = useState<{
    path: string;
    root: string;
    commentId?: string;
  } | null>(null);

  useEffect(() => {
    const thread = docThread?.thread;
    const anchor = docThread?.anchor;
    if (!docThreadId || !thread || !anchor) return;
    if (thread.channelId !== channelId) return;
    setBrowseFile({
      path: anchor.path,
      root: anchor.rootId,
      commentId: docThreadId,
    });
  }, [docThread, docThreadId, channelId]);

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

  async function startThread(input: {
    content: string;
    attachmentIds?: string[];
  }) {
    const { thread } = await create.mutateAsync(input);
    navigate(`/c/${channelId}/t/${thread.id}`);
  }

  return (
    <Page
      title={channel ? `# ${channel.name}` : "…"}
      titleExtra={
        <span className="flex min-w-0 items-center gap-2">
          {untaggedAgent ? (
            <Link
              to={`/agents/${untaggedAgent}`}
              title="Answers messages that do not start with @name"
              className="mention shrink-0 text-[11px] leading-5"
            >
              @{untaggedAgent}
            </Link>
          ) : null}
          <CommentedDocsButton
            channelId={channelId}
            onOpen={(doc) => setBrowseFile(doc)}
          />
        </span>
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
            onSend={(input) => void startThread(input)}
          />
        </div>

        {openPanel && selectedThread && (
          <ThreadPanel
            key={threadId}
            channelId={channelId}
            channelName={channel?.name}
            threadId={threadId!}
            turnActive={selectedThread.turnActive}
            turnAgent={selectedThread.turnAgent}
          />
        )}
        {browseFile && (
          <FileViewerDialog
            path={browseFile.path}
            url={workspaceFileUrl(browseFile.path, {
              channelId,
              root: browseFile.root,
            })}
            channelId={channelId}
            root={browseFile.root}
            focusCommentId={browseFile.commentId}
            onClose={() => {
              setBrowseFile(null);
              if (docThreadId) navigate(`/c/${channelId}`);
            }}
          />
        )}
      </div>
    </Page>
  );
}

function CommentedDocsButton({
  channelId,
  onOpen,
}: {
  channelId: string;
  onOpen: (doc: { path: string; root: string }) => void;
}) {
  const { data } = useDocCommentSummary(channelId);
  const docs = data?.docs ?? [];
  const unread = docs.reduce((n, doc) => n + doc.unreadCount, 0);
  return (
    <Popover>
      <PopoverTrigger
        title="Docs with comments"
        className="relative flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <FileText className="size-3.5" />
        {unread > 0 && (
          <span className="absolute top-1 right-1 size-1.5 rounded-full bg-sky-600" />
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-1 p-2">
        <p className="px-2 py-1 text-xs font-medium">Docs with comments</p>
        {docs.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No comments on files in this channel yet.
          </p>
        ) : (
          docs.map((doc) => (
            <button
              key={`${doc.rootId}:${doc.path}`}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
              onClick={() => onOpen({ path: doc.path, root: doc.rootId })}
            >
              <span className="min-w-0 flex-1 truncate">{doc.path}</span>
              <span className="text-muted-foreground">{doc.commentCount}</span>
              {doc.unreadCount > 0 && (
                <span className="size-1.5 rounded-full bg-sky-600" />
              )}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
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
