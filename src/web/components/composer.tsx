import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessage,
} from "@assistant-ui/react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/web/lib/utils";

const EMPTY_MESSAGES: readonly ThreadMessage[] = [];

export function Composer({
  placeholder,
  disabled,
  onSend,
  className,
}: {
  placeholder: string;
  disabled?: boolean;
  onSend: (content: string) => void | Promise<void>;
  className?: string;
}) {
  // The runtime blocks sends while the composer text is empty, so `content`
  // is always non-empty here.
  async function handleNew(message: AppendMessage) {
    const content = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    await onSend(content);
  }

  // The runtime exists only to power ComposerPrimitive (autosize textarea,
  // enter-to-send with IME guard); it never holds thread messages.
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    isDisabled: disabled,
    messages: EMPTY_MESSAGES,
    onNew: handleNew,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className={cn("shrink-0 px-5 pt-1 pb-5", className)}>
        <ComposerPrimitive.Root className="rounded-xl border bg-card shadow-lg shadow-black/10 transition-colors focus-within:border-ring/60 dark:shadow-black/40">
          <ComposerPrimitive.Input
            rows={1}
            maxRows={8}
            submitMode="enter"
            placeholder={placeholder}
            className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <div className="flex items-center justify-end px-2 pb-2">
            <ComposerPrimitive.Send
              aria-label="Send"
              className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
            >
              <ArrowUp className="size-4" />
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}
