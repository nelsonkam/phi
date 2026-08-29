import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Activity, Bot, Hash, MessageSquare } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/web/components/ui/command";
import { useChannels, useMessageSearch } from "@/web/lib/queries";
import { relativeTime } from "@/web/lib/time";

const SEARCH_DEBOUNCE_MS = 200;

// Cmd-K palette: jump to a page or channel by name, or full-text/semantic
// search across all messages via /api/v1/search. Navigation entries are
// filtered client-side; message results are ranked server-side, so cmdk's
// own filtering stays off.
export function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const { data: channelData } = useChannels();
  const { data: search, isFetching } = useMessageSearch(debounced);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebounced(query.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
    }
  }, [open]);

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  const normalized = query.trim().toLocaleLowerCase();
  const channels = (channelData?.channels ?? []).filter((channel) =>
    channel.name.toLocaleLowerCase().includes(normalized),
  );
  const pages = [
    { name: "Activity", to: "/", icon: Activity },
    { name: "Agents", to: "/agents", icon: Bot },
  ].filter((page) => page.name.toLocaleLowerCase().includes(normalized));
  const results = debounced ? (search?.results ?? []) : [];

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Jump to a channel or search messages"
    >
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search messages, channels…"
        />
        <CommandList>
          <CommandEmpty>
            {!debounced
              ? "Type to search messages."
              : isFetching
                ? "Searching…"
                : "No results."}
          </CommandEmpty>
          {(pages.length > 0 || channels.length > 0) && (
            <CommandGroup heading="Jump to">
              {pages.map((page) => (
                <CommandItem
                  key={page.to}
                  value={`page:${page.to}`}
                  onSelect={() => go(page.to)}
                >
                  <page.icon className="text-muted-foreground" />
                  {page.name}
                </CommandItem>
              ))}
              {channels.map((channel) => (
                <CommandItem
                  key={channel.id}
                  value={`channel:${channel.id}`}
                  onSelect={() => go(`/c/${channel.id}`)}
                >
                  <Hash className="text-muted-foreground" />
                  {channel.name}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {results.length > 0 && (
            <CommandGroup heading="Messages">
              {results.map((result) => (
                <CommandItem
                  key={result.messageId}
                  value={`message:${result.messageId}`}
                  onSelect={() => go(`/t/${result.threadId}`)}
                >
                  <MessageSquare className="text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{result.snippet}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      #{result.channel} · {result.author} ·{" "}
                      {relativeTime(result.createdAt)}
                      {result.threadHitCount > 1 &&
                        ` · ${result.threadHitCount} matches in thread`}
                    </p>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
