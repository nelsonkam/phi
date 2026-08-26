import { useEffect, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessage,
} from "@assistant-ui/react";
import { ArrowUp } from "lucide-react";
import type { Agent } from "@/shared/types";
import { AgentAvatar } from "@/web/components/agent-avatar";
import { readDraft, saveDraft } from "@/web/lib/drafts";
import { useAgents } from "@/web/lib/queries";
import { cn } from "@/web/lib/utils";

const EMPTY_MESSAGES: readonly ThreadMessage[] = [];

// Only a leading @name routes a message (docs/multi-agent.md §4), so the
// autocomplete opens only while the caret sits inside that leading token:
// everything before the caret is whitespace, "@", and name characters.
const LEADING_MENTION_PREFIX = /^\s*@([a-z0-9-]*)$/i;

export function Composer({
  placeholder,
  disabled,
  draftKey,
  onSend,
  className,
}: {
  placeholder: string;
  disabled?: boolean;
  /** When set, unsent text is persisted under this key and restored on mount. */
  draftKey?: string;
  onSend: (content: string) => void | Promise<void>;
  className?: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The prefix typed after the leading "@" while the autocomplete is open;
  // null when the caret is not in a leading mention.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const { data: agentData } = useAgents();

  const suggestions =
    mentionQuery === null
      ? []
      : (agentData?.agents ?? []).filter((agent) =>
          agent.name.toLowerCase().startsWith(mentionQuery.toLowerCase()),
        );
  const open = suggestions.length > 0;
  const active = Math.min(activeIndex, Math.max(suggestions.length - 1, 0));

  function syncMention(el: HTMLTextAreaElement) {
    const caret = el.selectionStart ?? el.value.length;
    const collapsed = el.selectionEnd === caret;
    const match = collapsed
      ? el.value.slice(0, caret).match(LEADING_MENTION_PREFIX)
      : null;
    const query = match ? (match[1] ?? "") : null;
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
    const leading = el.value.match(/^\s*/)?.[0] ?? "";
    const rest = el.value.slice(leading.length).replace(/^@[a-z0-9-]*/i, "");
    const inserted = `${leading}@${agent.name} `;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setValue?.call(el, inserted + rest.trimStart());
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.setSelectionRange(inserted.length, inserted.length);
    el.focus();
    setMentionQuery(null);
  }

  // Capture phase, so an accepting Enter or dismissing Escape never reaches
  // the primitive's own send / cancel handlers.
  function handleKeyDownCapture(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
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
  }

  // The runtime blocks sends while the composer text is empty, so `content`
  // is always non-empty here.
  async function handleNew(message: AppendMessage) {
    setMentionQuery(null);
    const content = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    await onSend(content);
  }

  // The runtime exists only to power ComposerPrimitive (autosize textarea,
  // enter-to-send with IME guard); it never holds thread messages.
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    isDisabled: disabled,
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
    composer.setText(readDraft(draftKey) ?? "");
    let lastText = composer.getState().text;
    return composer.subscribe(() => {
      const text = composer.getState().text;
      if (text === lastText) return;
      lastText = text;
      saveDraft(draftKey, text);
    });
  }, [draftKey, runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className={cn("shrink-0 px-5 pt-1 pb-5", className)}>
        <div className="relative">
          {open && (
            <div
              role="listbox"
              aria-label="Mention an agent"
              className="absolute inset-x-0 bottom-full z-10 mb-1.5 overflow-hidden rounded-lg border bg-popover py-1 shadow-sm shadow-black/10 dark:shadow-black/40"
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
            </div>
          )}
          <ComposerPrimitive.Root className="rounded-xl border bg-card shadow-xs shadow-black/10 transition-colors focus-within:border-ring/60 dark:shadow-black/40">
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
              className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground/60"
            />
            <div className="flex items-center justify-end px-2 pb-2">
              <ComposerPrimitive.Send
                aria-label="Send"
                className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
              >
                <ArrowUp className="size-4" />
              </ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
