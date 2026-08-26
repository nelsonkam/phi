import { Bot } from "lucide-react";
import type { Message } from "@/shared/types";
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

// One message in a flow: avatar gutter, author + time header, content.
export function MessageItem({
  message,
  children,
}: {
  message: Message;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
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
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {message.content}
        </p>
        {children}
      </div>
    </div>
  );
}
