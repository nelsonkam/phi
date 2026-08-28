// Composer drafts, persisted per channel/thread so unsent text (and uploaded
// attachment ids) survive a refresh or navigation. localStorage access can
// throw (blocked site data, private windows), so every call degrades to a
// no-op draft-less composer.

import { isAttachmentId } from "@/shared/attachments";

const PREFIX = "phi:draft:";

export interface DraftAttachment {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
}

export interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
}

export function readDraft(
  key: string,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): string | null {
  return readComposerDraft(key, storage)?.text || null;
}

export function readComposerDraft(
  key: string,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): ComposerDraft | null {
  try {
    const raw = storage?.getItem(PREFIX + key);
    if (raw === null || raw === undefined) return null;
    return parseDraft(raw);
  } catch {
    return null;
  }
}

// Whitespace-only text counts as no draft; saving it removes the entry so
// abandoned composers don't accumulate blank keys. Attachments keep a draft
// even when the text is empty.
export function saveDraft(
  key: string,
  text: string,
  storage:
    | Pick<Storage, "setItem" | "removeItem">
    | undefined = defaultStorage(),
): void {
  saveComposerDraft(key, { text, attachments: [] }, storage);
}

export function saveComposerDraft(
  key: string,
  draft: ComposerDraft,
  storage:
    | Pick<Storage, "setItem" | "removeItem">
    | undefined = defaultStorage(),
): void {
  try {
    const text = draft.text;
    const attachments = draft.attachments.filter((item) =>
      isAttachmentId(item.id),
    );
    if (!text.trim() && attachments.length === 0) {
      storage?.removeItem(PREFIX + key);
      return;
    }
    if (attachments.length === 0) {
      storage?.setItem(PREFIX + key, text);
      return;
    }
    storage?.setItem(
      PREFIX + key,
      JSON.stringify({ v: 1, text, attachments }),
    );
  } catch {
    // Ignore quota or access errors; the draft just isn't persisted.
  }
}

function parseDraft(raw: string): ComposerDraft {
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      text?: unknown;
      attachments?: unknown;
    };
    if (
      parsed &&
      parsed.v === 1 &&
      typeof parsed.text === "string" &&
      Array.isArray(parsed.attachments)
    ) {
      return {
        text: parsed.text,
        attachments: parsed.attachments.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const rec = item as Record<string, unknown>;
          if (
            typeof rec.id !== "string" ||
            !isAttachmentId(rec.id) ||
            typeof rec.filename !== "string" ||
            typeof rec.contentType !== "string" ||
            typeof rec.byteSize !== "number"
          ) {
            return [];
          }
          return [
            {
              id: rec.id,
              filename: rec.filename,
              contentType: rec.contentType,
              byteSize: rec.byteSize,
            },
          ];
        }),
      };
    }
  } catch {
    // Plain-text drafts from before this format.
  }
  return { text: raw, attachments: [] };
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
