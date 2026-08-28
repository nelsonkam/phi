import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, MessageSquareText, Square } from "lucide-react";
import type { DocCommentThread } from "@/shared/types";
import { Composer } from "@/web/components/composer";
import { AgentWorkingMessage, MessageItem } from "@/web/components/message";
import { RetryTurnButton } from "@/web/components/thread-panel";
import {
  useCancelTurn,
  useCreateDocComment,
  useDocComments,
  useMarkThreadRead,
  useMessages,
  useSendMessage,
  useThreadTurn,
} from "@/web/lib/queries";
import { latestCommittedMessageId } from "@/web/lib/activity";
import {
  buildTextProjection,
  captureSelectionAnchor,
  locateTextQuote,
  paintDocCommentHighlights,
  unwrapDocCommentMarks,
} from "@/web/lib/doc-comment-projection";
import { scrollToDocCommentAnchor } from "@/web/lib/heading-ids";
import { cn } from "@/web/lib/utils";

export function shouldOpenChannelThreadPanel(
  threadId: string | undefined,
  chatThreadIds: Iterable<string> | undefined,
): boolean {
  if (!threadId || !chatThreadIds) return false;
  for (const id of chatThreadIds) {
    if (id === threadId) return true;
  }
  return false;
}

export function shouldOpenActivityThreadPanel(
  threadId: string | undefined,
  activityHasThread: boolean,
  fetchedKind: string | undefined,
  fetched: boolean,
): boolean {
  if (!threadId) return false;
  if (fetchedKind === "doc_comment") return false;
  if (activityHasThread) return true;
  return fetched;
}

export function docCommentDeepLink(
  urlChannelId: string,
  urlKind: "thread" | "doc",
  thread:
    | { id: string; channelId: string; kind: string }
    | null
    | undefined,
): string | null {
  if (!thread || thread.kind !== "doc_comment") return null;
  const href = `/c/${thread.channelId}/doc/${thread.id}`;
  if (urlKind === "thread") return href;
  if (thread.channelId !== urlChannelId) return href;
  return null;
}

export function docCommentScrollLatch(
  selectedId: string | null,
  previous: string | null,
): { scroll: true; latch: string } | { scroll: false; latch: string | null } {
  if (!selectedId || selectedId === "new") {
    return { scroll: false, latch: null };
  }
  if (previous === selectedId) {
    return { scroll: false, latch: previous };
  }
  return { scroll: true, latch: selectedId };
}

export function DocCommentLayer({
  channelId,
  rootId,
  path,
  text,
  containerRef,
  focusThreadId,
}: {
  channelId: string;
  rootId: string;
  path: string;
  text: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  focusThreadId?: string;
}) {
  const { data, isFetched } = useDocComments(channelId, rootId, path);
  const comments = data?.comments ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(
    focusThreadId ?? null,
  );
  const [draft, setDraft] = useState<{
    quote: string;
    prefix: string;
    suffix: string;
    headingSlug: string | null;
    top: number;
    left: number;
  } | null>(null);
  const [popover, setPopover] = useState<{ top: number; left: number } | null>(
    null,
  );
  const scrolledId = useRef<string | null>(null);

  useEffect(() => {
    if (focusThreadId) setSelectedId(focusThreadId);
  }, [focusThreadId]);

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const painted = paintDocCommentHighlights(
      root,
      comments.map((comment) => ({
        id: comment.thread.id,
        quote: comment.anchor.quote,
        prefix: comment.anchor.prefix,
        suffix: comment.anchor.suffix,
        className: cn(
          "cursor-pointer rounded-sm bg-amber-300/40 dark:bg-amber-300/25",
          selectedId === comment.thread.id &&
            "bg-amber-400/70 dark:bg-amber-300/40",
        ),
      })),
    );
    for (const mark of painted) {
      mark.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setSelectedId(mark.dataset.docComment ?? null);
      });
    }
    return () => unwrapDocCommentMarks(painted);
  }, [comments, text, selectedId, containerRef]);

  useLayoutEffect(() => {
    const decision = docCommentScrollLatch(selectedId, scrolledId.current);
    if (!decision.scroll) {
      scrolledId.current = decision.latch;
      return;
    }
    const root = containerRef.current;
    const comment = comments.find((item) => item.thread.id === decision.latch);
    if (!root || (!comment && !isFetched)) return;
    scrollToDocCommentAnchor(root, {
      threadId: decision.latch,
      headingSlug: comment?.anchor.headingSlug ?? null,
    });
    scrolledId.current = decision.latch;
  }, [selectedId, comments, text, containerRef, isFetched]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    function onMouseUp() {
      const selection = window.getSelection();
      if (!selection || !root) {
        setPopover(null);
        return;
      }
      const anchor = captureSelectionAnchor(root, selection);
      if (!anchor) {
        setPopover(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setPopover({
        top: rect.bottom + 8,
        left: Math.max(8, rect.left),
      });
      setDraft({
        quote: anchor.quote,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        headingSlug: anchor.headingSlug,
        top: rect.bottom + 8,
        left: Math.max(8, rect.left),
      });
    }
    root.addEventListener("mouseup", onMouseUp);
    return () => root.removeEventListener("mouseup", onMouseUp);
  }, [containerRef, text]);

  const projectionText = containerRef.current
    ? buildTextProjection(containerRef.current).text
    : null;
  const located = comments.map((comment) => ({
    ...comment,
    // Detached is derived from the live rendered projection. Until the
    // container exists, leave the flag off so the panel does not flash.
    detached:
      projectionText !== null &&
      !locateTextQuote(
        projectionText,
        comment.anchor.quote,
        comment.anchor.prefix,
        comment.anchor.suffix,
      ),
  }));

  return (
    <>
      {popover && draft && !draft.quote ? null : popover && draft ? (
        <button
          type="button"
          data-comment-ineligible
          className="fixed z-50 rounded-md border bg-background px-2 py-1 text-xs font-medium shadow-sm hover:bg-accent"
          style={{ top: popover.top, left: popover.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setSelectedId("new");
            setPopover(null);
          }}
        >
          Comment
        </button>
      ) : null}
      <DocCommentPanel
        channelId={channelId}
        rootId={rootId}
        path={path}
        comments={located}
        selectedId={selectedId}
        draft={selectedId === "new" ? draft : null}
        onSelect={setSelectedId}
        onCreated={(id) => {
          setSelectedId(id);
          setDraft(null);
        }}
        onCancelNew={() => {
          setSelectedId(null);
          setDraft(null);
        }}
      />
    </>
  );
}

function DocCommentPanel({
  channelId,
  rootId,
  path,
  comments,
  selectedId,
  draft,
  onSelect,
  onCreated,
  onCancelNew,
}: {
  channelId: string;
  rootId: string;
  path: string;
  comments: Array<DocCommentThread & { detached?: boolean }>;
  selectedId: string | null;
  draft: {
    quote: string;
    prefix: string;
    suffix: string;
    headingSlug: string | null;
  } | null;
  onSelect: (id: string | null) => void;
  onCreated: (id: string) => void;
  onCancelNew: () => void;
}) {
  const create = useCreateDocComment(channelId);
  const selected = comments.find((item) => item.thread.id === selectedId);

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-l bg-background">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <MessageSquareText className="size-3.5 text-muted-foreground" />
        <h2 className="text-xs font-semibold">Comments</h2>
        <span className="text-xs text-muted-foreground">{comments.length}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {selectedId === "new" && draft && (
          <div className="border-b p-3">
            <p className="mb-2 line-clamp-3 rounded bg-amber-200/40 px-2 py-1 text-xs dark:bg-amber-300/20">
              {draft.quote}
            </p>
            <Composer
              placeholder="Add a comment — @mention an agent to get a reply"
              mentions="anywhere"
              draftKey={`doc-comment-new:${channelId}:${path}`}
              disabled={create.isPending}
              onSend={async (input) => {
                const { thread } = await create.mutateAsync({
                  content: input.content,
                  attachmentIds: input.attachmentIds,
                  rootId,
                  path,
                  quote: draft.quote,
                  prefix: draft.prefix,
                  suffix: draft.suffix,
                  headingSlug: draft.headingSlug,
                });
                onCreated(thread.id);
              }}
              className="p-0"
            />
            <button
              type="button"
              className="mt-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={onCancelNew}
            >
              Cancel
            </button>
          </div>
        )}
        {selected ? (
          <DocCommentThreadView
            channelId={channelId}
            comment={selected}
            onBack={() => onSelect(null)}
          />
        ) : (
          <ul className="p-2">
            {comments.length === 0 && selectedId !== "new" && (
              <li className="px-2 py-6 text-center text-xs text-muted-foreground">
                Select text to comment.
              </li>
            )}
            {comments.map((comment) => (
              <li key={comment.thread.id}>
                <button
                  type="button"
                  onClick={() => onSelect(comment.thread.id)}
                  className="w-full rounded-md px-2 py-2 text-left hover:bg-accent"
                >
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {comment.anchor.quote}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs">
                    {comment.latestMessage?.content ?? ""}
                  </p>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    {comment.detached && (
                      <span className="rounded bg-amber-200/50 px-1 text-amber-800 dark:bg-amber-300/20 dark:text-amber-200">
                        Detached
                      </span>
                    )}
                    {comment.unreadCount > 0 && (
                      <span className="size-1.5 rounded-full bg-sky-600" />
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function DocCommentThreadView({
  channelId,
  comment,
  onBack,
}: {
  channelId: string;
  comment: DocCommentThread & { detached?: boolean };
  onBack: () => void;
}) {
  const { data } = useMessages(comment.thread.id);
  const send = useSendMessage(comment.thread.id);
  const cancel = useCancelTurn(comment.thread.id);
  const messages = data?.messages ?? [];
  const liveTurn = useThreadTurn(comment.thread.id);
  const persistedAgent = comment.thread.turnActive
    ? (comment.thread.turnAgent ?? "agent")
    : null;
  const activeAgent = liveTurn.ready ? liveTurn.agent : persistedAgent;
  const isAgentWorking = send.isPending || activeAgent !== null;
  const workingAgent = activeAgent ?? comment.thread.turnAgent ?? "agent";
  const [stopping, setStopping] = useState(false);
  const stopBusy = cancel.isPending || stopping;
  const workingRef = useRef(isAgentWorking);
  workingRef.current = isAgentWorking;
  const last = messages[messages.length - 1];

  function requestStop() {
    if (stopBusy) return;
    cancel.mutate(undefined, {
      onSuccess: () => {
        if (workingRef.current) setStopping(true);
      },
    });
  }

  useEffect(() => {
    setStopping(false);
  }, [comment.thread.id, isAgentWorking]);

  const markRead = useMarkThreadRead();
  const markReadMutate = markRead.mutate;
  const committedId = latestCommittedMessageId(messages);
  useEffect(() => {
    if (committedId !== undefined) {
      markReadMutate({ threadId: comment.thread.id, channelId });
    }
  }, [markReadMutate, comment.thread.id, channelId, committedId]);

  return (
    <div className="flex min-h-full flex-col">
      <button
        type="button"
        onClick={onBack}
        className="px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        ← All comments
      </button>
      <blockquote className="mx-3 mb-2 rounded bg-amber-200/40 px-2 py-1 text-xs dark:bg-amber-300/20">
        {comment.anchor.quote}
      </blockquote>
      {comment.detached && (
        <p className="px-3 pb-2 text-[11px] text-amber-800 dark:text-amber-200">
          Detached — this quote is no longer in the document.
        </p>
      )}
      <div className="space-y-3 px-3 pb-3">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message}>
            {message.id === last?.id &&
              message.metadata.retriable === true &&
              !isAgentWorking && (
                <RetryTurnButton threadId={comment.thread.id} />
              )}
          </MessageItem>
        ))}
      </div>
      <div
        className={cn("working-row", isAgentWorking && "working-row-active")}
        aria-hidden={!isAgentWorking}
      >
        <div className="working-row-clip">
          <div className="px-3 pb-3">
            <AgentWorkingMessage
              agent={workingAgent}
              stopping={stopping}
              action={
                isAgentWorking ? (
                  <button
                    type="button"
                    title="Stop"
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
      <Composer
        placeholder="Reply — @mention an agent to get a reply"
        mentions="anywhere"
        draftKey={`doc-comment:${comment.thread.id}`}
        onSend={(input) => send.mutate(input)}
        className="px-3 pb-3"
      />
    </div>
  );
}
