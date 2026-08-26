import { TextMessagePartProvider } from "@assistant-ui/react";
import { Bot } from "lucide-react";
import type { Message } from "@/shared/types";
import { MarkdownText } from "@/web/components/assistant-ui/markdown-text";
import { relativeTime } from "@/web/lib/time";
import { cn } from "@/web/lib/utils";

export function AuthorAvatar({
  author,
  size = "md",
}: {
  author: Message["author"];
  size?: "md" | "sm";
}) {
  const isUser = author === "user";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg font-semibold select-none",
        size === "md" ? "size-9 text-sm" : "size-7 text-xs",
        isUser
          ? "bg-sky-600/90 text-white"
          : "bg-secondary text-muted-foreground",
      )}
    >
      {isUser ? "N" : <Bot className={size === "md" ? "size-5" : "size-4"} />}
    </span>
  );
}

export function authorLabel(author: Message["author"]): string {
  return author === "user" ? "You" : author;
}

export function AgentWorkingMessage({ agent }: { agent: string }) {
  return (
    <p
      className="ml-12 flex items-baseline gap-1 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <span className="font-medium text-foreground">{agent}</span>
      <span className="working-shimmer">is working...</span>
    </p>
  );
}

// One message in a flow: avatar gutter, author + time header, content.
// Agent replies render as markdown; user-typed text and error reports render
// verbatim so their newlines and markup-looking characters survive.
export function MessageItem({
  message,
  children,
}: {
  message: Message;
  children?: React.ReactNode;
}) {
  const renderAsMarkdown =
    message.author !== "user" && message.kind !== "error";
  return (
    <div className="message-enter flex gap-3">
      <AuthorAvatar author={message.author} />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">
            {authorLabel(message.author)}
          </span>
          <span className="text-xs text-muted-foreground">
            {relativeTime(message.createdAt)}
          </span>
        </p>
        {renderAsMarkdown ? (
          <div className="text-sm wrap-break-word">
            <TextMessagePartProvider text={message.content}>
              <MarkdownText />
            </TextMessagePartProvider>
          </div>
        ) : (
          <p
            className={cn(
              "text-sm leading-relaxed wrap-break-word whitespace-pre-wrap",
              message.kind === "error" && "text-destructive",
            )}
          >
            {message.content}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
