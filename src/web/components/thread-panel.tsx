import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { X } from "lucide-react";
import { Composer } from "@/web/components/composer";
import { AgentWorkingMessage, MessageItem } from "@/web/components/message";
import { useMessages, useSendMessage } from "@/web/lib/queries";
import { cn } from "@/web/lib/utils";

// Slack-style thread detail: opens beside the channel flow.
export function ThreadPanel({
  channelId,
  channelName,
  threadId,
}: {
  channelId: string;
  channelName: string | undefined;
  threadId: string;
}) {
  const { data } = useMessages(threadId);
  const send = useSendMessage(threadId);
  const messages = data?.messages ?? [];
  const [root, ...replies] = messages;
  const isAgentWorking = send.isPending || messages.at(-1)?.author === "user";

  const messageListRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  useEffect(() => {
    const messageList = messageListRef.current;
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
  }, [count, isAgentWorking, threadId]);

  return (
    <aside className="flex min-h-0 w-full max-w-md shrink-0 flex-col overflow-hidden border-l bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-sm font-semibold">Thread</h2>
        {channelName && (
          <span className="truncate text-xs text-muted-foreground">
            # {channelName}
          </span>
        )}
        <Link
          to={`/c/${channelId}`}
          aria-label="Close thread"
          className="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </Link>
      </header>

      <div ref={messageListRef} className="flex-1 overflow-y-auto">
        {root && (
          <div className="px-4 pt-4">
            <MessageItem message={root} />
          </div>
        )}
        {replies.length > 0 && (
          <div className="my-3 flex items-center gap-2 px-4">
            <span className="text-xs text-muted-foreground">
              {replies.length} {replies.length === 1 ? "reply" : "replies"}
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
        )}
        <div
          className={cn(
            "space-y-4 px-4 pb-4",
            replies.length === 0 && isAgentWorking && "pt-4",
          )}
        >
          {replies.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
          {isAgentWorking && <AgentWorkingMessage />}
        </div>
      </div>

      <Composer
        placeholder="Reply…"
        disabled={send.isPending}
        onSend={(content) => send.mutate(content)}
        className="px-4 pb-4"
      />
    </aside>
  );
}
