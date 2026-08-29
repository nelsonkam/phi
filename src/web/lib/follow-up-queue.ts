// Follow-ups queued while an agent is working. Persisted per composer draft
// key so a refresh does not drop unsent items. localStorage access can throw,
// so every call degrades to an in-memory (or empty) queue.

import { useCallback, useState } from "react";
import { isAttachmentId } from "@/shared/attachments";
import type { Attachment } from "@/shared/types";
import type { DraftAttachment } from "@/web/lib/drafts";

const PREFIX = "phi:followup:";

export type FollowUpItem = {
  id: string;
  content: string;
  attachments: DraftAttachment[];
};

export function readFollowUpQueue(
  key: string,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): FollowUpItem[] {
  try {
    const raw = storage?.getItem(PREFIX + key);
    if (!raw) return [];
    return parseQueue(raw);
  } catch {
    return [];
  }
}

export function saveFollowUpQueue(
  key: string,
  items: FollowUpItem[],
  storage:
    | Pick<Storage, "setItem" | "removeItem">
    | undefined = defaultStorage(),
): void {
  try {
    if (items.length === 0) {
      storage?.removeItem(PREFIX + key);
      return;
    }
    storage?.setItem(PREFIX + key, JSON.stringify({ v: 1, items }));
  } catch {
    // Ignore quota or access errors; the queue just isn't persisted.
  }
}

export function followUpDumpInput(items: readonly FollowUpItem[]): {
  content: string;
  attachmentIds: string[];
  attachments: Attachment[];
} {
  const content = items
    .map((item) => item.content.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
  const seen = new Set<string>();
  const attachments: Attachment[] = [];
  for (const item of items) {
    for (const attachment of item.attachments) {
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      attachments.push({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
        createdAt: "",
      });
    }
  }
  return {
    content,
    attachmentIds: attachments.map((attachment) => attachment.id),
    attachments,
  };
}

export function followUpSendInput(item: FollowUpItem): {
  content: string;
  attachmentIds: string[];
  attachments: Attachment[];
} {
  return followUpDumpInput([item]);
}

// Drop a stale editor id when the queue is replaced (thread/comment switch)
// or the edited row is gone. Returning null tells the composer it may dump.
export function retainedEditingId(
  editingId: string | null,
  items: readonly { id: string }[],
): string | null {
  if (editingId === null) return null;
  return items.some((item) => item.id === editingId) ? editingId : null;
}

// Composer Send while a queued row is loaded: write that row back (or drop it
// if the edit is empty). Otherwise the composer is composing a new follow-up.
export function followUpComposerCommit(
  editingId: string | null,
  input: { content: string; attachments: readonly unknown[] },
):
  | { action: "enqueue" }
  | { action: "update"; id: string }
  | { action: "remove"; id: string } {
  if (editingId === null) return { action: "enqueue" };
  if (!input.content.trim() && input.attachments.length === 0) {
    return { action: "remove", id: editingId };
  }
  return { action: "update", id: editingId };
}

export function attachmentsToDraft(
  attachments: Attachment[],
): DraftAttachment[] {
  return attachments.flatMap((attachment) =>
    isAttachmentId(attachment.id)
      ? [
          {
            id: attachment.id,
            filename: attachment.filename,
            contentType: attachment.contentType,
            byteSize: attachment.byteSize,
          },
        ]
      : [],
  );
}

export function useFollowUpQueue(key: string | undefined): {
  items: FollowUpItem[];
  enqueue: (input: {
    content: string;
    attachments: Attachment[];
  }) => void;
  remove: (id: string) => void;
  update: (
    id: string,
    patch: { content: string; attachments?: Attachment[] },
  ) => void;
  clear: () => void;
} {
  const [items, setItems] = useState<FollowUpItem[]>(() =>
    key ? readFollowUpQueue(key) : [],
  );
  const [loadedKey, setLoadedKey] = useState(key);
  if (key !== loadedKey) {
    setLoadedKey(key);
    setItems(key ? readFollowUpQueue(key) : []);
  }

  const enqueue = useCallback(
    (input: { content: string; attachments: Attachment[] }) => {
      const item: FollowUpItem = {
        id: `fu_${crypto.randomUUID()}`,
        content: input.content,
        attachments: attachmentsToDraft(input.attachments),
      };
      setItems((current) => {
        const next = [...current, item];
        if (key) saveFollowUpQueue(key, next);
        return next;
      });
    },
    [key],
  );

  const remove = useCallback(
    (id: string) => {
      setItems((current) => {
        const next = current.filter((item) => item.id !== id);
        if (key) saveFollowUpQueue(key, next);
        return next;
      });
    },
    [key],
  );

  const update = useCallback(
    (
      id: string,
      patch: { content: string; attachments?: Attachment[] },
    ) => {
      setItems((current) => {
        const next = current.map((item) =>
          item.id === id
            ? {
                ...item,
                content: patch.content,
                attachments:
                  patch.attachments !== undefined
                    ? attachmentsToDraft(patch.attachments)
                    : item.attachments,
              }
            : item,
        );
        if (key) saveFollowUpQueue(key, next);
        return next;
      });
    },
    [key],
  );

  const clear = useCallback(() => {
    setItems([]);
    if (key) saveFollowUpQueue(key, []);
  }, [key]);

  return { items, enqueue, remove, update, clear };
}

function parseQueue(raw: string): FollowUpItem[] {
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      items?: unknown;
    };
    if (parsed?.v !== 1 || !Array.isArray(parsed.items)) return [];
    return parsed.items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const rec = item as Record<string, unknown>;
      if (typeof rec.id !== "string" || typeof rec.content !== "string") {
        return [];
      }
      const attachments = Array.isArray(rec.attachments)
        ? rec.attachments.flatMap((attachment) => {
            if (!attachment || typeof attachment !== "object") return [];
            const row = attachment as Record<string, unknown>;
            if (
              typeof row.id !== "string" ||
              !isAttachmentId(row.id) ||
              typeof row.filename !== "string" ||
              typeof row.contentType !== "string" ||
              typeof row.byteSize !== "number"
            ) {
              return [];
            }
            return [
              {
                id: row.id,
                filename: row.filename,
                contentType: row.contentType,
                byteSize: row.byteSize,
              },
            ];
          })
        : [];
      return [{ id: rec.id, content: rec.content, attachments }];
    });
  } catch {
    return [];
  }
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
