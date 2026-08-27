// Composer drafts, persisted per channel/thread so unsent text survives a
// refresh or navigation. localStorage access can throw (blocked site data,
// private windows), so every call degrades to a no-op draft-less composer.

const PREFIX = "phi:draft:";

export function readDraft(
  key: string,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): string | null {
  try {
    return storage?.getItem(PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

// Whitespace-only text counts as no draft; saving it removes the entry so
// abandoned composers don't accumulate blank keys.
export function saveDraft(
  key: string,
  text: string,
  storage:
    | Pick<Storage, "setItem" | "removeItem">
    | undefined = defaultStorage(),
): void {
  try {
    if (text.trim()) storage?.setItem(PREFIX + key, text);
    else storage?.removeItem(PREFIX + key);
  } catch {
    // Ignore quota or access errors; the draft just isn't persisted.
  }
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
