import { useEffect, useRef } from "react";
import { ArrowUp, X } from "lucide-react";
import type { FollowUpItem } from "@/web/lib/follow-up-queue";
import { cn } from "@/web/lib/utils";

export function FollowUpQueue({
  items,
  selectedId,
  disabled,
  onEdit,
  onSend,
  onDismiss,
}: {
  items: FollowUpItem[];
  selectedId?: string | null;
  disabled?: boolean;
  onEdit: (item: FollowUpItem) => void;
  onSend: (item: FollowUpItem) => void;
  onDismiss: (id: string) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [items.length]);

  if (items.length === 0) return null;

  return (
    <ul
      ref={listRef}
      aria-label="Queued follow-ups"
      data-phi-follow-up-queue=""
      className="max-h-44 list-none overflow-x-hidden overflow-y-auto rounded-xl border bg-card shadow-xs shadow-black/10 dark:shadow-black/40"
    >
      {items.map((item) => (
        <FollowUpRow
          key={item.id}
          item={item}
          selected={selectedId === item.id}
          disabled={disabled}
          onEdit={() => onEdit(item)}
          onSend={() => onSend(item)}
          onDismiss={() => onDismiss(item.id)}
        />
      ))}
    </ul>
  );
}

function FollowUpRow({
  item,
  selected,
  disabled,
  onEdit,
  onSend,
  onDismiss,
}: {
  item: FollowUpItem;
  selected: boolean;
  disabled?: boolean;
  onEdit: () => void;
  onSend: () => void;
  onDismiss: () => void;
}) {
  const label = item.content.trim() || item.attachments[0]?.filename || "Follow-up";
  const waitTitle = disabled ? "Wait for the upload to finish" : undefined;

  return (
    <li
      data-phi-follow-up-item={item.id}
      data-phi-follow-up-editing={selected ? "" : undefined}
      className={cn(
        "flex items-center gap-2 border-b px-2.5 py-1 last:border-b-0 hover:bg-accent/40",
        selected && "bg-accent/50",
        disabled && "opacity-60",
      )}
    >
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onEdit}
          disabled={disabled}
          title={waitTitle ?? "Edit follow-up"}
          className="block w-full p-0 text-left text-sm leading-5 line-clamp-2 hover:text-foreground disabled:pointer-events-none"
        >
          {label}
        </button>
        {item.attachments.length > 0 && item.content.trim() && (
          <p className="truncate text-[11px] leading-4 text-muted-foreground">
            {item.attachments.map((attachment) => attachment.filename).join(", ")}
          </p>
        )}
      </div>
      <div className="flex h-6 shrink-0 items-center gap-0.5">
        <button
          type="button"
          data-phi-follow-up-send=""
          aria-label={`Send: ${label}`}
          title={waitTitle ?? "Send"}
          disabled={disabled}
          onClick={onSend}
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ArrowUp className="size-3" />
          Send
        </button>
        <button
          type="button"
          data-phi-follow-up-dismiss=""
          aria-label={`Remove: ${label}`}
          title={waitTitle ?? "Remove"}
          disabled={disabled}
          onClick={onDismiss}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </li>
  );
}
