import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessage,
} from "@assistant-ui/react";
import { ArrowUp, Paperclip, X } from "lucide-react";
import type { Agent, Attachment } from "@/shared/types";
import { AgentAvatar } from "@/web/components/agent-avatar";
import {
  dataTransferHasFiles,
  filesFromClipboard,
  filesFromDataTransfer,
  filesFromFileList,
  formatByteSize,
  takeFilesUpToLimit,
} from "@/web/lib/attachments";
import { uploadAttachment } from "@/web/lib/api";
import {
  readComposerDraft,
  saveComposerDraft,
  type DraftAttachment,
} from "@/web/lib/drafts";
import { useAgents } from "@/web/lib/queries";
import { cn } from "@/web/lib/utils";

const EMPTY_MESSAGES: readonly ThreadMessage[] = [];

// Chat composers only complete a leading @name (docs/multi-agent.md §4).
// Doc-comment composers pass mentions="anywhere" so an @ in the body works.
const LEADING_MENTION_PREFIX = /^\s*@([a-z0-9-]*)$/i;
// Prefix matches the server BODY_MENTION in routing.ts: start, whitespace,
// or an opening bracket. Completing after other punctuation would offer a
// handle the server will not route.
const ANYWHERE_MENTION_PREFIX = /(?:^|[\s([{])@([a-z0-9-]*)$/i;

export function mentionTokenAtCaret(
  value: string,
  caret: number,
  mode: "leading" | "anywhere",
): { start: number; query: string } | null {
  const before = value.slice(0, Math.max(0, Math.min(caret, value.length)));
  const match =
    mode === "leading"
      ? before.match(LEADING_MENTION_PREFIX)
      : before.match(ANYWHERE_MENTION_PREFIX);
  if (!match) return null;
  return { start: before.lastIndexOf("@"), query: match[1] ?? "" };
}

type PendingAttachment =
  | { status: "uploading"; key: string; filename: string; byteSize: number }
  | {
      status: "ready";
      key: string;
      attachment: Attachment;
    }
  | { status: "error"; key: string; filename: string; error: string };

export type ComposerSendInput = {
  content: string;
  attachmentIds: string[];
  attachments: Attachment[];
};

export function Composer({
  placeholder,
  disabled,
  draftKey,
  onSend,
  className,
  mentions = "leading",
}: {
  placeholder: string;
  disabled?: boolean;
  /** When set, unsent text is persisted under this key and restored on mount. */
  draftKey?: string;
  onSend: (input: ComposerSendInput) => void | Promise<void>;
  className?: string;
  /** Chat: leading @ only. Doc comments: @ anywhere in the body. */
  mentions?: "leading" | "anywhere";
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The prefix typed after the leading "@" while the autocomplete is open;
  // null when the caret is not in a leading mention.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [mentionBox, setMentionBox] = useState<{
    left: number;
    width: number;
    bottom: number;
  } | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [overflowNotice, setOverflowNotice] = useState<string | null>(null);
  const { data: agentData } = useAgents();

  const suggestions =
    mentionQuery === null
      ? []
      : (agentData?.agents ?? []).filter((agent) =>
          agent.name.toLowerCase().startsWith(mentionQuery.toLowerCase()),
        );
  const open = suggestions.length > 0;
  const active = Math.min(activeIndex, Math.max(suggestions.length - 1, 0));
  const uploading = pending.some((item) => item.status === "uploading");
  const ready = pending.flatMap((item) =>
    item.status === "ready" ? [item.attachment] : [],
  );

  useLayoutEffect(() => {
    if (!open) {
      setMentionBox(null);
      return;
    }
    function place() {
      const el = inputRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setMentionBox({
        left: rect.left,
        width: rect.width,
        bottom: window.innerHeight - rect.top + 6,
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, mentionQuery]);

  function syncMention(el: HTMLTextAreaElement) {
    const caret = el.selectionStart ?? el.value.length;
    const collapsed = el.selectionEnd === caret;
    const token = collapsed
      ? mentionTokenAtCaret(el.value, caret, mentions)
      : null;
    const query = token ? token.query : null;
    setMentionQuery((previous) => {
      if (previous !== query) setActiveIndex(0);
      return query;
    });
  }

  // Writes through the native value setter and dispatches an input event so
  // the change flows into assistant-ui's controlled composer state.
  function acceptMention(agent: Agent) {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const token = mentionTokenAtCaret(el.value, caret, mentions);
    if (!token) return;
    const inserted = `${el.value.slice(0, token.start)}@${agent.name} `;
    const next = inserted + el.value.slice(caret).replace(/^\s+/, "");
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setValue?.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.setSelectionRange(inserted.length, inserted.length);
    el.focus();
    setMentionQuery(null);
  }

  function addFiles(incoming: File[]) {
    if (incoming.length === 0) return;
    const currentCount = pending.filter(
      (item) => item.status !== "error",
    ).length;
    const { files, overflow } = takeFilesUpToLimit(currentCount, incoming);
    setOverflowNotice(
      overflow > 0 ? `Only ${files.length} more file(s) can be attached.` : null,
    );
    if (files.length === 0) return;
    const batch = files.map((file) => ({
      status: "uploading" as const,
      key: `up-${crypto.randomUUID()}`,
      filename: file.name || "file",
      byteSize: file.size,
      file,
    }));
    setPending((current) => [
      ...current,
      ...batch.map(({ file: _file, ...item }) => item),
    ]);
    for (const item of batch) {
      void uploadAttachment(item.file)
        .then((attachment) => {
          setPending((current) =>
            current.map((row) =>
              row.key === item.key
                ? { status: "ready", key: item.key, attachment }
                : row,
            ),
          );
        })
        .catch((error: unknown) => {
          setPending((current) =>
            current.map((row) =>
              row.key === item.key
                ? {
                    status: "error",
                    key: item.key,
                    filename: item.filename,
                    error:
                      error instanceof Error ? error.message : "Upload failed",
                  }
                : row,
            ),
          );
        });
    }
  }

  // Capture phase, so an accepting Enter or dismissing Escape never reaches
  // the primitive's own send / cancel handlers.
  function handleKeyDownCapture(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActiveIndex(
          (active + step + suggestions.length) % suggestions.length,
        );
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        acceptMention(suggestions[active]!);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMentionQuery(null);
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      const text = e.currentTarget.value.trim();
      if (!text && ready.length > 0 && !uploading && !disabled) {
        e.preventDefault();
        e.stopPropagation();
        void submit(text);
      }
    }
  }

  async function submit(content: string) {
    if (disabled || uploading) return;
    if (!content && ready.length === 0) return;
    setMentionQuery(null);
    await onSend({
      content,
      attachmentIds: ready.map((item) => item.id),
      attachments: ready,
    });
    setPending([]);
    setOverflowNotice(null);
  }

  // The runtime blocks sends while the composer text is empty, so attachments
  // without text go through submit() directly (button click / empty Enter).
  async function handleNew(message: AppendMessage) {
    const content = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    await submit(content);
  }

  // The runtime exists only to power ComposerPrimitive (autosize textarea,
  // enter-to-send with IME guard); it never holds thread messages.
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    isDisabled: disabled || uploading,
    messages: EMPTY_MESSAGES,
    onNew: handleNew,
  });

  // Restores the draft for the current key (replacing any text left over from
  // a previous key) and persists every subsequent edit. Sending resets the
  // composer text to "", which flows through the same subscription and removes
  // the stored draft.
  useEffect(() => {
    if (!draftKey) return;
    const composer = runtime.thread.composer;
    const draft = readComposerDraft(draftKey);
    composer.setText(draft?.text ?? "");
    setPending(
      (draft?.attachments ?? []).map(draftAttachmentToPending),
    );
    let lastText = composer.getState().text;
    return composer.subscribe(() => {
      const text = composer.getState().text;
      if (text === lastText) return;
      lastText = text;
      persistDraft(draftKey, text, pendingRef.current);
    });
  }, [draftKey, runtime]);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    if (!draftKey) return;
    persistDraft(
      draftKey,
      runtime.thread.composer.getState().text,
      pending,
    );
  }, [draftKey, pending, runtime]);

  const composerText = inputRef.current?.value ?? "";
  const canSend =
    !disabled &&
    !uploading &&
    (composerText.trim().length > 0 || ready.length > 0);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className={cn("shrink-0 px-5 pt-1 pb-5", className)}>
        <div className="relative">
          {open &&
            mentionBox &&
            createPortal(
              <div
                role="listbox"
                aria-label="Mention an agent"
                data-phi-mention-listbox=""
                style={{
                  position: "fixed",
                  left: mentionBox.left,
                  width: mentionBox.width,
                  bottom: mentionBox.bottom,
                }}
                className="pointer-events-auto z-[80] overflow-hidden rounded-lg border bg-popover py-1 shadow-sm shadow-black/10 dark:shadow-black/40"
              >
                {suggestions.map((agent, index) => (
                  <button
                    key={agent.name}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    // Mousedown, not click: the textarea must keep focus.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptMention(agent);
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-sm",
                      index === active && "bg-accent",
                    )}
                  >
                    <AgentAvatar name={agent.name} size="sm" />
                    <span className="shrink-0 font-medium">@{agent.name}</span>
                    {agent.description && (
                      <span className="truncate text-xs text-muted-foreground">
                        {agent.description}
                      </span>
                    )}
                  </button>
                ))}
              </div>,
              document.body,
            )}
          <ComposerPrimitive.Root
            className={cn(
              "rounded-xl border bg-card shadow-xs shadow-black/10 transition-colors focus-within:border-ring/60 dark:shadow-black/40",
              dragOver && "border-ring/80 bg-accent/40",
            )}
            onDragEnter={(e) => {
              if (!dataTransferHasFiles(e.dataTransfer)) return;
              e.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(e) => {
              if (!dataTransferHasFiles(e.dataTransfer)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDragOver(false);
            }}
            onDrop={(e) => {
              if (!dataTransferHasFiles(e.dataTransfer)) return;
              e.preventDefault();
              setDragOver(false);
              addFiles(filesFromDataTransfer(e.dataTransfer));
            }}
          >
            {pending.length > 0 && (
              <ul className="flex flex-wrap gap-1.5 px-3 pt-3">
                {pending.map((item) => (
                  <li key={item.key}>
                    <AttachmentChip
                      item={item}
                      onRemove={() =>
                        setPending((current) =>
                          current.filter((row) => row.key !== item.key),
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
            <ComposerPrimitive.Input
              ref={inputRef}
              rows={1}
              maxRows={8}
              submitMode="enter"
              placeholder={placeholder}
              onKeyDownCapture={handleKeyDownCapture}
              onChange={(e) => syncMention(e.currentTarget)}
              // Covers caret moves that change no text (clicks, arrow keys).
              onSelect={(e) => syncMention(e.currentTarget)}
              onPaste={(e) => {
                const files = filesFromClipboard(e.clipboardData);
                if (files.length === 0) return;
                e.preventDefault();
                addFiles(files);
              }}
              className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground/60"
            />
            <div className="flex items-center justify-between px-2 pb-2">
              <input
                ref={fileRef}
                type="file"
                multiple
                className="sr-only"
                aria-hidden="true"
                tabIndex={-1}
                onChange={(e) => {
                  addFiles(filesFromFileList(e.currentTarget.files));
                  e.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                aria-label="Attach files"
                title="Attach files"
                disabled={disabled}
                onClick={() => fileRef.current?.click()}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
              >
                <Paperclip className="size-4" />
              </button>
              {ready.length > 0 && !composerText.trim() ? (
                <button
                  type="button"
                  aria-label="Send"
                  disabled={!canSend}
                  onClick={() => {
                    void submit(
                      runtime.thread.composer.getState().text.trim(),
                    );
                    runtime.thread.composer.setText("");
                  }}
                  className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
                >
                  <ArrowUp className="size-4" />
                </button>
              ) : (
                <ComposerPrimitive.Send
                  aria-label="Send"
                  className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
                >
                  <ArrowUp className="size-4" />
                </ComposerPrimitive.Send>
              )}
            </div>
          </ComposerPrimitive.Root>
          {overflowNotice && (
            <p className="px-1 pt-1.5 text-xs text-muted-foreground">
              {overflowNotice}
            </p>
          )}
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}

function draftAttachmentToPending(item: DraftAttachment): PendingAttachment {
  return {
    status: "ready",
    key: item.id,
    attachment: {
      id: item.id,
      filename: item.filename,
      contentType: item.contentType,
      byteSize: item.byteSize,
      createdAt: "",
    },
  };
}

function persistDraft(
  key: string,
  text: string,
  pending: PendingAttachment[],
) {
  saveComposerDraft(key, {
    text,
    attachments: pending.flatMap((item) =>
      item.status === "ready"
        ? [
            {
              id: item.attachment.id,
              filename: item.attachment.filename,
              contentType: item.attachment.contentType,
              byteSize: item.attachment.byteSize,
            },
          ]
        : [],
    ),
  });
}

function AttachmentChip({
  item,
  onRemove,
}: {
  item: PendingAttachment;
  onRemove: () => void;
}) {
  const filename =
    item.status === "ready" ? item.attachment.filename : item.filename;
  const detail =
    item.status === "uploading"
      ? "Uploading…"
      : item.status === "error"
        ? item.error
        : formatByteSize(item.attachment.byteSize);
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs",
        item.status === "error" && "border-destructive/40 text-destructive",
      )}
    >
      <span className="truncate" title={filename}>
        {filename}
      </span>
      <span className="shrink-0 text-muted-foreground">{detail}</span>
      <button
        type="button"
        aria-label={`Remove ${filename}`}
        onClick={onRemove}
        className="flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
