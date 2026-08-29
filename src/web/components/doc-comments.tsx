import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { Check, Copy, LoaderCircle, MessageSquareText, Square } from "lucide-react";
import type { DocCommentThread } from "@/shared/types";
import { Composer } from "@/web/components/composer";
import { AgentWorkingMessage, MessageItem, authorLabel } from "@/web/components/message";
import { RetryTurnButton } from "@/web/components/thread-panel";
import {
  useAgents,
  useCancelTurn,
  useCreateDocComment,
  useDocComments,
  useMarkThreadRead,
  useMessages,
  useSendMessage,
  useThreadTurn,
  useUpdateThreadStatus,
} from "@/web/lib/queries";
import { latestCommittedMessageId } from "@/web/lib/activity";
import {
  clearDocCommentAnchor,
  docCommentDraftKey,
  readDocCommentAnchor,
  saveDocCommentAnchor,
} from "@/web/lib/drafts";
import {
  buildTextProjection,
  captureSelectionAnchor,
  locateTextQuote,
  paintDocCommentHighlights,
  unwrapDocCommentMarks,
} from "@/web/lib/doc-comment-projection";
import { scrollToDocCommentAnchor } from "@/web/lib/heading-ids";
import { threadUntaggedAgent } from "@/web/lib/thread-agent";
import { relativeTime } from "@/web/lib/time";
import { useStickToBottom } from "@/web/lib/use-stick-to-bottom";
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

export function commentReplyPlaceholder(agent: string | null, kind: "new" | "reply"): string {
  const verb = kind === "new" ? "Add a comment" : "Reply";
  return agent ? `${verb} — @${agent} will answer` : verb;
}

export function shouldSelectExistingComment(
  selection: { isCollapsed: boolean; anchorNode: Node | null } | null,
  root: Node,
): boolean {
  if (!selection || selection.isCollapsed || !selection.anchorNode) return true;
  return !root.contains(selection.anchorNode);
}

export function shouldOpenThreadFromClick(
  currentTarget: EventTarget | null,
  target: EventTarget | null,
): boolean {
  if (currentTarget == null || target == null) return false;
  if (typeof Node === "undefined") return false;
  if (!(currentTarget instanceof Node) || !(target instanceof Node)) return false;
  if (!currentTarget.contains(target)) return false;
  const el = target instanceof Element ? target : target.parentElement;
  if (el?.closest("a, button")) return false;
  return true;
}

export type BrowseFileState = {
  path: string;
  root?: string;
  commentId?: string;
  parentThreadId?: string;
  fragment?: string;
};

export function mergeBrowseFileFromDocLink(
  prev: BrowseFileState | null,
  next: { path: string; root: string; commentId: string },
): BrowseFileState {
  const sameDoc =
    prev != null &&
    prev.path === next.path &&
    (prev.root == null || prev.root === next.root);
  return {
    path: next.path,
    root: next.root,
    commentId: next.commentId,
    parentThreadId: sameDoc ? prev.parentThreadId : undefined,
    fragment: sameDoc ? prev.fragment : undefined,
  };
}

export function docCommentSyncPath(
  channelId: string,
  selectedId: string | null,
  currentPath: string,
): string | null {
  if (selectedId && selectedId !== "new") {
    return `/c/${channelId}/doc/${selectedId}`;
  }
  if (currentPath.includes(`/c/${channelId}/doc/`)) {
    return `/c/${channelId}`;
  }
  return null;
}

function sameIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function sameOffsetMap(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, offset] of a) if (b.get(id) !== offset) return false;
  return true;
}

// Stable identity while the comments query is pending. A fresh [] every
// render re-fires the paint layout effect, which setStates new Set/Map
// identities and loops until React throws (error #185).
const EMPTY_COMMENTS: DocCommentThread[] = [];

export function DocCommentLayer({
  channelId,
  rootId,
  path,
  text,
  containerRef,
  parentThreadId,
  focusThreadId,
  onDraftOpenChange,
  fullscreen,
  syncRoute,
}: {
  channelId: string;
  rootId: string;
  path: string;
  text: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  parentThreadId?: string;
  focusThreadId?: string;
  onDraftOpenChange?: (open: boolean) => void;
  fullscreen?: boolean;
  syncRoute?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data } = useDocComments(channelId, rootId, path);
  const comments = data?.comments ?? EMPTY_COMMENTS;
  const draftKey = docCommentDraftKey(channelId, rootId, path);
  const [selectedId, setSelectedId] = useState<string | null>(
    focusThreadId ?? null,
  );
  const [draft, setDraft] = useState<{
    quote: string;
    prefix: string;
    suffix: string;
    headingSlug: string | null;
  } | null>(null);
  const [popover, setPopover] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [detachedIds, setDetachedIds] = useState<Set<string>>(() => new Set());
  const [offsets, setOffsets] = useState<Map<string, number>>(() => new Map());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const scrolledId = useRef<string | null>(null);
  const draftLocked = selectedId === "new" && draft !== null;

  useEffect(() => {
    if (focusThreadId) {
      setSelectedId(focusThreadId);
      return;
    }
    const stored = readDocCommentAnchor(draftKey);
    if (stored) {
      setDraft(stored);
      setSelectedId("new");
    }
  }, [focusThreadId, draftKey]);

  useEffect(() => {
    onDraftOpenChange?.(Boolean(popover || draftLocked));
  }, [popover, draftLocked, onDraftOpenChange]);

  useEffect(() => {
    if (!syncRoute) return;
    const next = docCommentSyncPath(channelId, selectedId, location.pathname);
    if (!next || next === location.pathname) return;
    navigate(next, { replace: true });
  }, [syncRoute, selectedId, channelId, navigate, location.pathname]);

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const projection = buildTextProjection(root);
    const nextDetached = new Set<string>();
    const nextOffsets = new Map<string, number>();
    for (const comment of comments) {
      const match = locateTextQuote(
        projection.text,
        comment.anchor.quote,
        comment.anchor.prefix,
        comment.anchor.suffix,
      );
      if (!match) nextDetached.add(comment.thread.id);
      else nextOffsets.set(comment.thread.id, match.start);
    }
    setDetachedIds((prev) => (sameIdSet(prev, nextDetached) ? prev : nextDetached));
    setOffsets((prev) => (sameOffsetMap(prev, nextOffsets) ? prev : nextOffsets));
    const painted = paintDocCommentHighlights(
      root,
      comments.map((comment) => ({
        id: comment.thread.id,
        quote: comment.anchor.quote,
        prefix: comment.anchor.prefix,
        suffix: comment.anchor.suffix,
        className: cn(
          "cursor-pointer rounded-sm transition-colors",
          comment.thread.status === "open"
            ? "bg-amber-300/40 hover:bg-amber-400/55 dark:bg-amber-300/25 dark:hover:bg-amber-300/40"
            : "bg-amber-300/15 hover:bg-amber-300/25 dark:bg-amber-300/10 dark:hover:bg-amber-300/20",
          (selectedId === comment.thread.id || hoveredId === comment.thread.id) &&
            (comment.thread.status === "open"
              ? "bg-amber-400/70 dark:bg-amber-300/40"
              : "bg-amber-300/30 dark:bg-amber-300/20"),
        ),
      })),
    );
    for (const mark of painted) {
      mark.tabIndex = 0;
      mark.addEventListener("click", (event) => {
        if (!shouldSelectExistingComment(window.getSelection(), root)) return;
        event.preventDefault();
        event.stopPropagation();
        setSelectedId(mark.dataset.docComment ?? null);
      });
      mark.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setSelectedId(mark.dataset.docComment ?? null);
      });
    }
    return () => unwrapDocCommentMarks(painted);
  }, [comments, text, selectedId, hoveredId, containerRef]);

  useLayoutEffect(() => {
    const decision = docCommentScrollLatch(selectedId, scrolledId.current);
    if (!decision.scroll) {
      scrolledId.current = decision.latch;
      return;
    }
    const root = containerRef.current;
    const comment = comments.find((item) => item.thread.id === decision.latch);
    // Wait until the comments query includes the new thread; latching on a
    // miss would skip the highlight forever.
    if (!root || !comment) return;
    scrollToDocCommentAnchor(root, {
      threadId: decision.latch,
      headingSlug: comment.anchor.headingSlug,
    });
    scrolledId.current = decision.latch;
  }, [selectedId, comments, text, containerRef]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    function onSelectionChange() {
      if (draftLocked || !root) return;
      const selection = window.getSelection();
      if (!selection) {
        setPopover(null);
        return;
      }
      const anchor = captureSelectionAnchor(root, selection);
      if (!anchor) {
        setPopover(null);
        return;
      }
      const position = commentPopoverPosition(root, selection);
      if (!position) {
        setPopover(null);
        return;
      }
      setPopover(position);
      setDraft({
        quote: anchor.quote,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        headingSlug: anchor.headingSlug,
      });
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [containerRef, text, draftLocked]);

  useEffect(() => {
    if (!popover || draftLocked) return;
    const root = containerRef.current;
    if (!root) return;
    function reposition() {
      if (!root) return;
      const selection = window.getSelection();
      const position = selection
        ? commentPopoverPosition(root, selection)
        : null;
      if (!position) {
        setPopover(null);
        return;
      }
      setPopover(position);
    }
    const scrollRoot = root.closest(".overflow-auto") ?? root.parentElement;
    scrollRoot?.addEventListener("scroll", reposition, { passive: true });
    window.addEventListener("scroll", reposition, {
      capture: true,
      passive: true,
    });
    return () => {
      scrollRoot?.removeEventListener("scroll", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [popover, draftLocked, containerRef]);

  const located = [...comments]
    .map((comment) => ({
      ...comment,
      detached: detachedIds.has(comment.thread.id),
    }))
    .sort((a, b) => {
      if (a.detached !== b.detached) return a.detached ? 1 : -1;
      const ao = offsets.get(a.thread.id) ?? Number.MAX_SAFE_INTEGER;
      const bo = offsets.get(b.thread.id) ?? Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });

  function beginDraft() {
    if (!draft) return;
    saveDocCommentAnchor(draftKey, draft);
    setSelectedId("new");
    setPopover(null);
  }

  function cancelDraft() {
    clearDocCommentAnchor(draftKey);
    setSelectedId(null);
    setDraft(null);
    setPopover(null);
  }

  return (
    <>
      {popover && draft
        ? createPortal(
            <button
              type="button"
              data-comment-ineligible
              data-phi-comment-popover=""
              className="pointer-events-auto fixed z-[80] rounded-md border bg-background px-2 py-1 text-xs font-medium shadow-sm hover:bg-accent"
              style={{ top: popover.top, left: popover.left }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={beginDraft}
            >
              Comment
            </button>,
            document.body,
          )
        : null}
      <DocCommentPanel
        channelId={channelId}
        rootId={rootId}
        path={path}
        comments={located}
        selectedId={selectedId}
        draft={selectedId === "new" ? draft : null}
        draftKey={draftKey}
        parentThreadId={parentThreadId}
        fullscreen={fullscreen}
        onSelect={setSelectedId}
        onHover={(id) => {
          setHoveredId(id);
          if (!id || !containerRef.current) return;
          containerRef.current
            .querySelector(`[data-doc-comment="${CSS.escape(id)}"]`)
            ?.scrollIntoView({ block: "center" });
        }}
        onCreated={(id) => {
          clearDocCommentAnchor(draftKey);
          setSelectedId(id);
          setDraft(null);
        }}
        onCancelNew={cancelDraft}
      />
    </>
  );
}

function commentPopoverPosition(
  root: Element,
  selection: Selection,
): { top: number; left: number } | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const rect = range.getBoundingClientRect();
  const bounds = root.getBoundingClientRect();
  if (rect.bottom < bounds.top || rect.top > bounds.bottom) return null;
  const viewportHeight =
    typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerHeight;
  const viewportWidth =
    typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
  if (
    rect.bottom < 0 ||
    rect.top > viewportHeight ||
    rect.right < 0 ||
    rect.left > viewportWidth
  ) {
    return null;
  }
  return { top: rect.bottom + 8, left: Math.max(8, rect.left) };
}

function DocCommentPanel({
  channelId,
  rootId,
  path,
  comments,
  selectedId,
  draft,
  draftKey,
  parentThreadId,
  fullscreen,
  onSelect,
  onHover,
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
  draftKey: string;
  parentThreadId?: string;
  fullscreen?: boolean;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onCreated: (id: string) => void;
  onCancelNew: () => void;
}) {
  const create = useCreateDocComment(channelId);
  const selected = comments.find((item) => item.thread.id === selectedId);
  const fallbackAgent = useCommentFallbackAgent(parentThreadId);
  const open = comments.filter((item) => item.thread.status === "open");
  const resolved = comments.filter((item) => item.thread.status !== "open");
  const headerCount = open.length;

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-l bg-background",
        fullscreen ? "w-[28rem]" : "min-w-72 w-1/3",
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <MessageSquareText className="size-3.5 text-muted-foreground" />
        <h2 className="text-xs font-semibold">Comments</h2>
        <span className="text-xs text-muted-foreground">{headerCount}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {selectedId === "new" && draft && (
          <div className="shrink-0 border-b p-3">
            <p className="mb-2 line-clamp-3 rounded bg-amber-200/40 px-2 py-1 text-xs dark:bg-amber-300/20">
              {draft.quote}
            </p>
            <Composer
              placeholder={commentReplyPlaceholder(fallbackAgent, "new")}
              mentions="anywhere"
              draftKey={draftKey}
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
                  parentThreadId,
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
            key={selected.thread.id}
            channelId={channelId}
            comment={selected}
            onBack={() => onSelect(null)}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ul className="p-2">
              {open.length === 0 && selectedId !== "new" && (
                <li className="px-2 py-6 text-center text-xs text-muted-foreground">
                  Select text to comment.
                </li>
              )}
              {open.map((comment) => (
                <CommentListItem
                  key={comment.thread.id}
                  comment={comment}
                  onSelect={onSelect}
                  onHover={onHover}
                />
              ))}
            </ul>
            {resolved.length > 0 && (
              <details className="border-t px-2 py-2">
                <summary className="cursor-pointer px-2 text-xs text-muted-foreground">
                  {resolved.length} resolved
                </summary>
                <ul className="mt-1">
                  {resolved.map((comment) => (
                    <CommentListItem
                      key={comment.thread.id}
                      comment={comment}
                      onSelect={onSelect}
                      onHover={onHover}
                    />
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function CommentListItem({
  comment,
  onSelect,
  onHover,
}: {
  comment: DocCommentThread & { detached?: boolean };
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}) {
  const replies = Math.max(0, comment.messageCount - 1);
  const latest = comment.latestMessage;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(comment.thread.id)}
        onMouseEnter={() => onHover(comment.thread.id)}
        onMouseLeave={() => onHover(null)}
        className="w-full rounded-md px-2 py-2 text-left hover:bg-accent"
      >
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {comment.anchor.quote}
        </p>
        <p className="mt-1 line-clamp-2 text-xs">
          {latest?.content ?? ""}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {latest && <span>{authorLabel(latest)}</span>}
          {latest && <span>{relativeTime(latest.createdAt)}</span>}
          <span>
            {replies === 0
              ? "No replies"
              : `${replies} ${replies === 1 ? "reply" : "replies"}`}
          </span>
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
  );
}

function useCommentFallbackAgent(parentThreadId: string | null | undefined): string | null {
  const { data: agentData } = useAgents();
  const { data: parentMessages } = useMessages(parentThreadId ?? undefined);
  return threadUntaggedAgent(parentMessages?.messages, agentData?.agents);
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
  const { data: agentData } = useAgents();
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
  const fallbackAgent = threadUntaggedAgent(messages, agentData?.agents);
  const status = useUpdateThreadStatus(channelId);
  const [copied, setCopied] = useState(false);
  const resolved = comment.thread.status !== "open";
  const { scrollProps, contentRef } = useStickToBottom(
    messages.length,
    comment.thread.id,
  );

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b bg-background">
        <div className="flex items-center gap-2 px-3 py-2">
          <button
            type="button"
            onClick={onBack}
            className="text-left text-xs text-muted-foreground hover:text-foreground"
          >
            ← All comments
          </button>
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              title="Copy link"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={async () => {
                const url = `${window.location.origin}/c/${channelId}/doc/${comment.thread.id}`;
                await navigator.clipboard.writeText(url);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              disabled={status.isPending}
              onClick={() =>
                status.mutate({
                  threadId: comment.thread.id,
                  status: resolved ? "open" : "settled",
                })
              }
            >
              {resolved ? "Reopen" : "Resolve"}
            </button>
          </span>
        </div>
        <blockquote className="mx-3 mb-2 rounded bg-amber-200/40 px-2 py-1 text-xs dark:bg-amber-300/20">
          {comment.anchor.quote}
        </blockquote>
        {comment.detached && (
          <p className="px-3 pb-2 text-[11px] text-amber-800 dark:text-amber-200">
            Detached — this quote is no longer in the document.
          </p>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div {...scrollProps} className="h-full overflow-y-auto">
          <div ref={contentRef}>
            <div className="space-y-3 px-3 py-3">
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
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t bg-background">
        <Composer
          placeholder={commentReplyPlaceholder(fallbackAgent, "reply")}
          mentions="anywhere"
          draftKey={`doc-comment:${comment.thread.id}`}
          onSend={(input) => void send.mutateAsync(input)}
          onSteer={async (input) => {
            await cancel.mutateAsync();
            await send.mutateAsync(input);
          }}
          followUpMode={isAgentWorking}
          className="px-3 py-3"
        />
      </div>
    </div>
  );
}
