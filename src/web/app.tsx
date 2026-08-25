import { useEffect, useState } from "react";
import { Bot, Inbox } from "lucide-react";
import type { Channel } from "@/shared/types";
import { fetchChannels } from "@/web/lib/api";
import { connectDeltaSocket, type ConnectionStatus } from "@/web/lib/ws";
import { cn } from "@/web/lib/utils";

type ActiveView =
  | { kind: "inbox" }
  | { kind: "agents" }
  | { kind: "channel"; channelId: string };

export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [view, setView] = useState<ActiveView>({ kind: "inbox" });
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    fetchChannels().then(({ channels }) => setChannels(channels));
    return connectDeltaSocket({
      onFrame: () => {},
      onStatus: setStatus,
    });
  }, []);

  const activeChannel =
    view.kind === "channel"
      ? channels.find((c) => c.id === view.channelId)
      : undefined;

  const title =
    view.kind === "inbox"
      ? "Inbox"
      : view.kind === "agents"
        ? "Agents"
        : activeChannel
          ? `# ${activeChannel.name}`
          : "No channel";

  return (
    <div className="flex h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <header className="flex h-12 items-center gap-2 border-b border-sidebar-border px-4">
          <span className="text-sm font-semibold tracking-tight">phi</span>
          <span
            title={status}
            className={cn(
              "ml-auto size-2 rounded-full",
              status === "connected" && "bg-emerald-500",
              status === "connecting" && "bg-amber-500",
              status === "disconnected" && "bg-red-500",
            )}
          />
        </header>
        <nav className="flex-1 overflow-y-auto p-2">
          <SidebarItem
            active={view.kind === "inbox"}
            onClick={() => setView({ kind: "inbox" })}
          >
            <Inbox className="size-4" />
            Inbox
          </SidebarItem>
          <SidebarItem
            active={view.kind === "agents"}
            onClick={() => setView({ kind: "agents" })}
          >
            <Bot className="size-4" />
            Agents
          </SidebarItem>

          <p className="mt-4 px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Channels
          </p>
          {channels.map((channel) => (
            <SidebarItem
              key={channel.id}
              active={view.kind === "channel" && view.channelId === channel.id}
              onClick={() => setView({ kind: "channel", channelId: channel.id })}
            >
              <span className="w-4 text-center text-muted-foreground">#</span>
              {channel.name}
            </SidebarItem>
          ))}
        </nav>
      </aside>

      <main className="flex flex-1 flex-col">
        <header className="flex h-12 items-center border-b px-4">
          <h1 className="text-sm font-medium">{title}</h1>
        </header>
        <section className="flex flex-1 items-center justify-center">
          <EmptyState view={view} />
        </section>
      </main>
    </div>
  );
}

function SidebarItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        active && "bg-accent text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}

function EmptyState({ view }: { view: ActiveView }) {
  const copy =
    view.kind === "inbox"
      ? "Nothing needs your attention."
      : view.kind === "agents"
        ? "No agents configured yet."
        : "No threads yet.";
  return (
    <div className="text-center">
      <p className="text-sm text-muted-foreground">{copy}</p>
    </div>
  );
}
