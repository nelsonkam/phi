import { expect, test } from "bun:test";
import {
  fileKind,
  parseWorkspaceHref,
  resolveLinkedPath,
  workspaceDirname,
  workspaceFileUrl,
} from "@/web/lib/file-links";

test("workspaceFileUrl decodes each segment once before encoding", () => {
  expect(workspaceFileUrl("My%20Report.md")).toBe(
    "/api/v1/files/My%20Report.md",
  );
  expect(workspaceFileUrl("docs/My%20Report.md")).toBe(
    "/api/v1/files/docs/My%20Report.md",
  );
  expect(workspaceFileUrl("./notes.txt")).toBe("/api/v1/files/notes.txt");
});

test("workspaceFileUrl keeps fragments and drops query from the filename", () => {
  expect(workspaceFileUrl("report.md#summary")).toBe(
    "/api/v1/files/report.md#summary",
  );
  expect(parseWorkspaceHref("report.md?raw=1#summary")).toEqual({
    path: "report.md",
    fragment: "summary",
  });
  expect(fileKind("report.md#summary")).toBe("markdown");
  expect(fileKind("photo.png?size=full")).toBe("image");
});

test("channel-scoped URLs search or pin a root", () => {
  expect(
    workspaceFileUrl("src/server/files.ts", { channelId: "ch_phi" }),
  ).toBe("/api/v1/channels/ch_phi/files/src/server/files.ts");
  expect(
    workspaceFileUrl("src/server/files.ts", {
      channelId: "ch_phi",
      root: "phi",
    }),
  ).toBe("/api/v1/channels/ch_phi/file-roots/phi/src/server/files.ts");
});

test("resolveLinkedPath joins against the containing file directory", () => {
  expect(resolveLinkedPath("./chart.png", "channels/reports")).toBe(
    "channels/reports/chart.png",
  );
  expect(resolveLinkedPath("chart.png", "channels/reports")).toBe(
    "channels/reports/chart.png",
  );
  expect(resolveLinkedPath("../other.md", "channels/reports")).toBe(
    "channels/other.md",
  );
  expect(resolveLinkedPath("channels/general/report.md")).toBe(
    "channels/general/report.md",
  );
  expect(workspaceDirname("channels/reports/report.md")).toBe(
    "channels/reports",
  );
});
