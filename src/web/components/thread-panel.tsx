import { useEffect } from "react";
import { Link } from "react-router";
import { RotateCcw, X } from "lucide-react";
import { Composer } from "@/web/components/composer";
import { JumpToLatest } from "@/web/components/jump-to-latest";
import { AgentWorkingMessage, MessageItem } from "@/web/components/message";
import { UntaggedAgentTag } from "@/web/components/untagged-agent-tag";
import {
  useAgents,
  useMarkThreadRead,
  useMessages,
  useRetryTurn,
  useSendMessage,
  useThreadTurn,
} from "@/web/lib/queries";
import { latestCommittedMessageId } from "@/web/lib/activity";
import { threadUntaggedAgent } from "@/web/lib/thread-agent";
import { useStickToBottom } from "@/web/lib/use-stick-to-bottom";
import { cn } from "@/web/lib/utils";

// Slack-style thread detail: opens beside the channel flow.
export function ThreadPanel({
  channelId,
  channelName,
  threadId,
  turnActive,
  turnAgent,
  closeTo,
}: {
  channelId: string;
  channelName: string | undefined;
  threadId: string;
  turnActive: boolean;
  turnAgent: string | null;
  // Where the close button navigates; defaults to the thread's channel.
  closeTo?: string;
}) {
  const { data } = useMessages(threadId);
  const { data: agentData } = useAgents();
  const send = useSendMessage(threadId);
  const messages = data?.messages ?? [];
  const [root, ...replies] = messages;
  const untaggedAgent = threadUntaggedAgent(root, agentData?.agents);
  const liveTurn = useThreadTurn(threadId);
  const persistedAgent = turnActive ? (turnAgent ?? "agent") : null;
  const activeAgent = liveTurn.ready ? liveTurn.agent : persistedAgent;
  const isAgentWorking = send.isPending || activeAgent !== null;
  const workingAgent = activeAgent ?? turnAgent ?? "agent";

  const { scrollProps, pinned, hasNew, scrollToBottom } = useStickToBottom(
    messages.length,
    threadId,
  );

  // Viewing the thread reads it: advance the watermark on open and again as
  // messages land while the panel stays open. Keyed on the latest committed
  // message id — an optimistic row's predicted seq can equal the committed
  // one's, so a seq key could skip the re-advance after a send commits.
  const markRead = useMarkThreadRead();
  const markReadMutate = markRead.mutate;
  const committedId = latestCommittedMessageId(messages);
  useEffect(() => {
    if (committedId !== undefined) markReadMutate(threadId);
  }, [markReadMutate, threadId, committedId]);

  return (
    <aside className="flex min-h-0 w-1/2 shrink-0 flex-col overflow-hidden border-l bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-sm font-semibold">Thread</h2>
        {channelName && (
          <span className="truncate text-xs text-muted-foreground">
            # {channelName}
          </span>
        )}
        {untaggedAgent && <UntaggedAgentTag name={untaggedAgent} />}
        <Link
          to={closeTo ?? `/c/${channelId}`}
          aria-label="Close thread"
          className="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </Link>
      </header>

      <div className="relative min-h-0 flex-1">
        <div {...scrollProps} className="h-full overflow-y-auto">
          {root && (
            <div className="px-4 pt-4">
              <MessageItem message={root} />
            </div>
          )}
          {replies.length > 0 && (
            <div className="my-3 flex items-center gap-2 px-4">
              <span className="text-xs text-muted-foreground">
                {replies.length} {replies.length === 1 ? "reply" : "replies"}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          <div className="space-y-4 px-4 pb-4">
            {replies.map((message, index) => (
              <MessageItem key={message.id} message={message}>
                {index === replies.length - 1 &&
                  message.metadata.retriable === true &&
                  !isAgentWorking && <RetryTurnButton threadId={threadId} />}
              </MessageItem>
            ))}
          </div>
          {/* Kept mounted so the working state fades and collapses instead of
              popping in and out and shifting the layout. */}
          <div
            className={cn("working-row", isAgentWorking && "working-row-active")}
            aria-hidden={!isAgentWorking}
          >
            <div className="working-row-clip">
              <div className="px-4 pb-4">
                <AgentWorkingMessage agent={workingAgent} />
              </div>
            </div>
          </div>
        </div>
        {!pinned && (
          <JumpToLatest hasNew={hasNew} onClick={() => scrollToBottom()} />
        )}
      </div>

      {send.isError && (
        <p className="px-4 pb-1 text-xs text-destructive">
          Sending failed: {send.error.message}
        </p>
      )}
      <Composer
        placeholder="Reply…"
        onSend={(content) => send.mutate(content)}
        className="px-4 pb-4"
      />
    </aside>
  );
}

// Shown under the newest message when it reports a failed turn; re-runs the
// thread's last user message. The turn frames it triggers hide the button
// (isAgentWorking) the moment the retry lands.
function RetryTurnButton({ threadId }: { threadId: string }) {
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
