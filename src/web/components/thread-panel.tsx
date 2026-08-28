import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { LoaderCircle, RotateCcw, Square, X } from "lucide-react";
import { Composer } from "@/web/components/composer";
import { JumpToLatest } from "@/web/components/jump-to-latest";
import { AgentWorkingMessage, MessageItem } from "@/web/components/message";
import {
  useAgents,
  useMarkThreadRead,
  useMessages,
  useCancelTurn,
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
  const cancel = useCancelTurn(threadId);
  const messages = data?.messages ?? [];
  const [root, ...replies] = messages;
  const untaggedAgent = threadUntaggedAgent(messages, agentData?.agents);
  const liveTurn = useThreadTurn(threadId);
  const persistedAgent = turnActive ? (turnAgent ?? "agent") : null;
  const activeAgent = liveTurn.ready ? liveTurn.agent : persistedAgent;
  const isAgentWorking = send.isPending || activeAgent !== null;
  const workingAgent = activeAgent ?? turnAgent ?? "agent";
  // The cancel POST returns before the harness actually stops, so keep a
  // local "stopping" latch until the working flag clears.
  const [stopping, setStopping] = useState(false);
  const stopBusy = cancel.isPending || stopping;
  const workingRef = useRef(isAgentWorking);
  workingRef.current = isAgentWorking;

  function requestStop() {
    if (stopBusy) return;
    cancel.mutate(undefined, {
      onSuccess: () => {
        if (workingRef.current) setStopping(true);
      },
    });
  }

  // Reset on any working-state or thread change so a late cancel 202 cannot
  // latch "Stopping…" onto the next turn (presence can beat the POST).
  useEffect(() => {
    setStopping(false);
  }, [threadId, isAgentWorking]);

  useEffect(() => {
    if (!isAgentWorking || stopBusy) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[role='dialog']")) {
        return;
      }
      event.preventDefault();
      requestStop();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isAgentWorking, stopBusy]);

  const { scrollProps, contentRef, pinned, hasNew, scrollToBottom } =
    useStickToBottom(messages.length, threadId);

  // Viewing the thread reads it: advance the watermark on open and again as
  // messages land while the panel stays open. Keyed on the latest committed
  // message id — an optimistic row's predicted seq can equal the committed
  // one's, so a seq key could skip the re-advance after a send commits.
  const markRead = useMarkThreadRead();
  const markReadMutate = markRead.mutate;
  const committedId = latestCommittedMessageId(messages);
  useEffect(() => {
    if (committedId !== undefined) markReadMutate({ threadId, channelId });
  }, [markReadMutate, threadId, channelId, committedId]);

  return (
    <aside className="flex min-h-0 w-1/2 shrink-0 flex-col overflow-hidden border-l bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-sm font-semibold">Thread</h2>
        {channelName && (
          <span className="truncate text-xs text-muted-foreground">
            # {channelName}
          </span>
        )}
        {untaggedAgent && (
          <Link
            to={`/agents/${untaggedAgent}`}
            title="Answers messages that do not start with @name"
            className="mention shrink-0 text-[11px] leading-5"
          >
            @{untaggedAgent}
          </Link>
        )}
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
          <div ref={contentRef}>
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
                popping in and out and shifting the layout. Height growth is
                followed by stick-to-bottom via contentRef. */}
            <div
              className={cn("working-row", isAgentWorking && "working-row-active")}
              aria-hidden={!isAgentWorking}
            >
              <div className="working-row-clip">
                <div className="px-4 pb-4">
                  <AgentWorkingMessage
                    agent={workingAgent}
                    stopping={stopping}
                    action={
                      isAgentWorking ? (
                        <button
                          type="button"
                          title="Stop (Esc)"
                          onClick={requestStop}
                          disabled={stopBusy}
                          className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-100 disabled:pointer-events-none"
                        >
                          {stopping ? (
                            <LoaderCircle className="size-3 animate-spin" />
                          ) : (
                            <Square className="size-3 fill-current" />
                          )}
                          {stopping ? "Stopping…" : "Stop"}
                        </button>
                      ) : undefined
                    }
                  />
                </div>
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
      {cancel.isError && (
        <p className="px-4 pb-1 text-xs text-destructive">
          Stop failed: {cancel.error.message}
        </p>
      )}
      <Composer
        placeholder="Reply…"
        draftKey={`thread:${threadId}`}
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
