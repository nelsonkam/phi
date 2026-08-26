import { TextMessagePartProvider } from "@assistant-ui/react";
import { Bot } from "lucide-react";
import type { Message } from "@/shared/types";
import { AgentAvatar } from "@/web/components/agent-avatar";
import { MarkdownText } from "@/web/components/assistant-ui/markdown-text";
import { renderMentions, useKnownAgentNames } from "@/web/lib/mentions";
import { relativeTime } from "@/web/lib/time";
import { cn } from "@/web/lib/utils";

// The agent name an agent-authored message carries in its metadata.
function agentNameOf(message: Pick<Message, "author" | "metadata">): string {
  const agent = message.metadata.agent;
  return typeof agent === "string" ? agent : "agent";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function AuthorAvatar({
  message,
  size = "md",
}: {
  message: Pick<Message, "author" | "metadata">;
  size?: "md" | "sm";
}) {
  if (message.author === "user") {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg bg-sky-600/90 font-semibold text-white select-none",
          size === "md" ? "size-9 text-sm" : "size-7 text-xs",
        )}
      >
        N
      </span>
    );
  }
  if (message.author === "agent") {
    return <AgentAvatar name={agentNameOf(message)} size={size} />;
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground select-none",
        size === "md" ? "size-9" : "size-7",
      )}
    >
      <Bot className={size === "md" ? "size-5" : "size-4"} />
    </span>
  );
}

export function authorLabel(
  message: Pick<Message, "author" | "metadata">,
): string {
  if (message.author === "user") return "You";
  if (message.author === "agent") return agentNameOf(message);
  return "system";
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

// Agent messages that hand the turn to other agents (explicit `to` or a
// leading mention) show who they were routed to beside the timestamp.
function HandoffChips({ message }: { message: Message }) {
  if (message.author !== "agent") return null;
  const recipients = stringList(message.metadata.routedTo);
  if (recipients.length === 0) return null;
  return (
    <>
      {recipients.map((name) => (
        <span
          key={name}
          title={`Handed off to @${name}`}
          className="mention text-[11px]"
        >
          → @{name}
        </span>
      ))}
    </>
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
  const knownAgents = useKnownAgentNames();
  const renderAsMarkdown =
    message.author !== "user" && message.kind !== "error";
  return (
    <div className="message-enter flex gap-3">
      <AuthorAvatar message={message} />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{authorLabel(message)}</span>
          <span className="text-xs text-muted-foreground">
            {relativeTime(message.createdAt)}
          </span>
          <HandoffChips message={message} />
        </p>
        {renderAsMarkdown ? (
          <div className="text-sm wrap-break-word">
            <TextMessagePartProvider text={message.content}>
              <MarkdownText mentionNames={knownAgents} />
            </TextMessagePartProvider>
          </div>
        ) : (
          <p
            className={cn(
              "text-sm leading-relaxed wrap-break-word whitespace-pre-wrap",
              message.kind === "error" && "text-destructive",
            )}
          >
            {renderMentions(message.content, knownAgents)}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
