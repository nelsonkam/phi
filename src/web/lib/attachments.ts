import { DEFAULT_UPLOAD_MAX_FILES } from "@/shared/attachments";

export { parseAttachmentHref, attachmentApiPath } from "@/shared/attachments";

export function filesFromFileList(
  list: FileList | File[] | null | undefined,
): File[] {
  if (!list) return [];
  return Array.from(list);
}

export function filesFromDataTransfer(
  data: DataTransfer | null | undefined,
): File[] {
  if (!data) return [];
  return filesFromFileList(data.files);
}

// Screenshot paste often lives on items, not files.
export function filesFromClipboard(
  data: DataTransfer | null | undefined,
): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return filesFromFileList(data.files);
}

export function dataTransferHasFiles(
  data: DataTransfer | null | undefined,
): boolean {
  if (!data) return false;
  return Array.from(data.types).includes("Files");
}

export function takeFilesUpToLimit(
  currentCount: number,
  incoming: File[],
  limit: number = DEFAULT_UPLOAD_MAX_FILES,
): { files: File[]; overflow: number } {
  const room = Math.max(0, limit - currentCount);
  return {
    files: incoming.slice(0, room),
    overflow: Math.max(0, incoming.length - room),
  };
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
