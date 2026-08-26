import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/web/lib/utils";

// Full-width elevated message input, Slack-style: a floating card with the
// send control inside. Enter sends, Shift+Enter inserts a newline.
export function Composer({
  placeholder,
  disabled,
  onSend,
  className,
}: {
  placeholder: string;
  disabled?: boolean;
  onSend: (content: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState("");

  function send() {
    const content = value.trim();
    if (!content || disabled) return;
    onSend(content);
    setValue("");
  }

  return (
    <div className={cn("shrink-0 px-5 pt-1 pb-5", className)}>
      <div className="rounded-xl border bg-card shadow-lg shadow-black/10 transition-colors focus-within:border-ring/60 dark:shadow-black/40">
        <textarea
          rows={Math.min(8, Math.max(1, value.split("\n").length))}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground/60"
        />
        <div className="flex items-center justify-end px-2 pb-2">
          <button
            type="button"
            onClick={send}
            disabled={disabled || !value.trim()}
            aria-label="Send"
            className={cn(
              "flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity",
              (disabled || !value.trim()) && "opacity-30",
            )}
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
