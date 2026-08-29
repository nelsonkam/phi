import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileLink } from "@/web/components/file-link";
import { MessageItem } from "@/web/components/message";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Message } from "@/shared/types";

const id = `att_${"f".repeat(32)}`;

test("FileLink treats attachment hrefs as chips, not workspace paths", () => {
  const html = renderToStaticMarkup(
    <FileLink path={`attachment:${id}`} label="notes.pdf" />,
  );
  expect(html).toContain("notes.pdf");
  expect(html).toContain("<button");
  expect(html).toContain("text-sm");
  expect(html).not.toContain("/api/v1/files/");
});

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    workspaceId: "ws_default",
    channelId: "ch_general",
    threadId: "th_1",
    author: "user",
    kind: "message",
    content: "look",
    metadata: {},
    seq: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("non-image attachment chips use text-sm even outside the message body", () => {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MessageItem
        message={message({
          metadata: {
            attachments: [
              {
                id,
                filename: "buildSandBaseSystemPrompt.js",
                contentType: "text/javascript",
                byteSize: 12,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        })}
      />
    </QueryClientProvider>,
  );
  const chip = html.match(/<button[^>]*>[\s\S]*?buildSandBaseSystemPrompt\.js/);
  expect(chip?.[0]).toContain("text-sm");
});

test("user messages render attachment thumbnails from metadata", () => {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MessageItem
        message={message({
          metadata: {
            attachments: [
              {
                id,
                filename: "shot.png",
                contentType: "image/png",
                byteSize: 12,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        })}
      />
    </QueryClientProvider>,
  );
  expect(html).toContain("look");
  expect(html).toContain(`/api/v1/attachments/${id}`);
  expect(html).toContain("shot.png");
});
