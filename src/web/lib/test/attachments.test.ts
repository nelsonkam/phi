import { expect, test } from "bun:test";
import { DEFAULT_UPLOAD_MAX_FILES } from "@/shared/attachments";
import {
  filesFromClipboard,
  filesFromDataTransfer,
  filesFromFileList,
  formatByteSize,
  takeFilesUpToLimit,
} from "@/web/lib/attachments";

test("takeFilesUpToLimit keeps the composer under the server-side cap", () => {
  const incoming = Array.from(
    { length: 5 },
    (_, i) => new File(["x"], `f${i}.txt`),
  );
  const { files, overflow } = takeFilesUpToLimit(
    DEFAULT_UPLOAD_MAX_FILES - 2,
    incoming,
  );
  expect(files).toHaveLength(2);
  expect(overflow).toBe(3);
});

test("filesFromFileList copies a FileList-like array", () => {
  const file = new File(["hi"], "a.txt");
  expect(filesFromFileList([file])).toEqual([file]);
  expect(filesFromFileList(null)).toEqual([]);
});

test("filesFromClipboard prefers item files over the files list", () => {
  const pasted = new File(["img"], "shot.png", { type: "image/png" });
  const clipboard = {
    items: [
      {
        kind: "file",
        getAsFile: () => pasted,
      },
    ],
    files: [] as File[],
  } as unknown as DataTransfer;
  expect(filesFromClipboard(clipboard)).toEqual([pasted]);
});

test("filesFromDataTransfer reads dropped files", () => {
  const dropped = new File(["doc"], "notes.pdf");
  const data = { files: [dropped] } as unknown as DataTransfer;
  expect(filesFromDataTransfer(data)).toEqual([dropped]);
});

test("formatByteSize is stable for chip labels", () => {
  expect(formatByteSize(500)).toBe("500 B");
  expect(formatByteSize(2048)).toBe("2.0 KB");
  expect(formatByteSize(2 * 1024 * 1024)).toBe("2.0 MB");
});
