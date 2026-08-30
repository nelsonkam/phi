import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { CircleGauge, FileText, LoaderCircle, RotateCcw, Square, X } from "lucide-react";
import { Composer } from "@/web/components/composer";
import { FileViewerDialog } from "@/web/components/file-link";
import { JumpToLatest } from "@/web/components/jump-to-latest";
import { AgentWorkingMessage, MessageItem } from "@/web/components/message";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/web/components/ui/popover";
import {
  useAgents,
  useDocCommentSummary,
  useMarkThreadRead,
  useMessages,
  useCancelTurn,
  useRetryTurn,
  useSendMessage,
  useThreadTurn,
  useUpdateThreadOutcome,
} from "@/web/lib/queries";
import { latestCommittedMessageId } from "@/web/lib/activity";
import { useFileViewerOutlet } from "@/web/lib/file-link-context";
import { workspaceFileUrl } from "@/web/lib/file-links";
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
  outcome,
  closeTo,
}: {
  channelId: string;
  channelName: string | undefined;
  threadId: string;
  turnActive: boolean;
  turnAgent: string | null;
  outcome: "worked" | "needed_rework" | "user_corrected" | null;
  // Where the close button navigates; defaults to the thread's channel.
  closeTo?: string;
}) {
  const { data } = useMessages(threadId);
  const { data: agentData } = useAgents();
  const send = useSendMessage(threadId);
  const cancel = useCancelTurn(threadId);
  const updateOutcome = useUpdateThreadOutcome(channelId, threadId);
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
        <div className="ml-auto flex shrink-0 items-center">
          <OutcomeButton
            outcome={outcome}
            disabled={updateOutcome.isPending}
            onSelect={(next) => updateOutcome.mutate(next)}
          />
          <CommentedDocsButton channelId={channelId} threadId={threadId} />
          <Link
            to={closeTo ?? `/c/${channelId}`}
            aria-label="Close thread"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </Link>
        </div>
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
        onSend={(input) => void send.mutateAsync(input)}
        onSteer={async (input) => {
          await cancel.mutateAsync();
          await send.mutateAsync(input);
        }}
        followUpMode={isAgentWorking}
        className="px-4 pb-4"
      />
    </aside>
  );
}

const OUTCOME_LABELS = {
  worked: "Worked",
  needed_rework: "Needed rework",
  user_corrected: "User corrected",
} as const;

function OutcomeButton({
  outcome,
  disabled,
  onSelect,
}: {
  outcome: keyof typeof OUTCOME_LABELS | null;
  disabled: boolean;
  onSelect: (outcome: keyof typeof OUTCOME_LABELS | null) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        title={outcome ? `Outcome: ${OUTCOME_LABELS[outcome]}` : "Tag outcome"}
        disabled={disabled}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <CircleGauge className={cn("size-3.5", outcome && "text-sky-600")} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 gap-1 p-1">
        {(Object.entries(OUTCOME_LABELS) as Array<
          [keyof typeof OUTCOME_LABELS, string]
        >).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onSelect(value)}
            className={cn(
              "w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent",
              outcome === value && "bg-accent font-medium",
            )}
          >
            {label}
          </button>
        ))}
        {outcome && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent"
          >
            Clear outcome
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function CommentedDocsButton({
  channelId,
  threadId,
}: {
  channelId: string;
  threadId: string;
}) {
  const { data } = useDocCommentSummary(channelId, threadId);
  const docs = data?.docs ?? [];
  const unread = docs.reduce((n, doc) => n + doc.unreadCount, 0);
  const outlet = useFileViewerOutlet();
  const [open, setOpen] = useState(false);
  const [browseFile, setBrowseFile] = useState<{
    path: string;
    root: string;
  } | null>(null);

  function openDoc(doc: { path: string; rootId: string }) {
    setOpen(false);
    const next = {
      path: doc.path,
      root: doc.rootId,
      parentThreadId: threadId,
    };
    if (outlet) {
      outlet(next);
      return;
    }
    setBrowseFile({ path: doc.path, root: doc.rootId });
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
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
              No comments on files in this thread yet.
            </p>
          ) : (
            docs.map((doc) => (
              <button
                key={`${doc.rootId}:${doc.path}`}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => openDoc(doc)}
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
      {browseFile && (
        <FileViewerDialog
          path={browseFile.path}
          url={workspaceFileUrl(browseFile.path, {
            channelId,
            root: browseFile.root,
          })}
          channelId={channelId}
          root={browseFile.root}
          parentThreadId={threadId}
          onClose={() => setBrowseFile(null)}
        />
      )}
    </>
  );
}

// Shown under the newest message when it reports a failed turn; re-runs the
// thread's last user message. The turn frames it triggers hide the button
// (isAgentWorking) the moment the retry lands.
export function RetryTurnButton({ threadId }: { threadId: string }) {
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
