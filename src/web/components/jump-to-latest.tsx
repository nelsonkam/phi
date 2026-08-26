import { ArrowDown } from "lucide-react";

// Floating affordance shown when the reader has scrolled away from the
// bottom of a chat flow; new content raises `hasNew` instead of yanking
// their scroll position.
export function JumpToLatest({
  hasNew,
  onClick,
}: {
  hasNew: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-xs font-medium shadow-md transition-colors hover:bg-accent"
    >
      <ArrowDown className="size-3.5" />
      {hasNew ? "New messages" : "Latest"}
    </button>
  );
}
