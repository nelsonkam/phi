import { useEffect, useState } from "react";
import type { Channel } from "../shared/types";
import { fetchChannels } from "./lib/api";
import { connectDeltaSocket, type ConnectionStatus } from "./lib/ws";
import { cn } from "./lib/utils";

export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    fetchChannels().then(({ channels }) => {
      setChannels(channels);
      setActiveChannelId((current) => current ?? channels[0]?.id ?? null);
    });
    return connectDeltaSocket({
      onFrame: () => {},
      onStatus: setStatus,
    });
  }, []);

  const activeChannel = channels.find((c) => c.id === activeChannelId);

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
          <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Channels
          </p>
          {channels.map((channel) => (
            <button
              key={channel.id}
              onClick={() => setActiveChannelId(channel.id)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                channel.id === activeChannelId &&
                  "bg-accent text-accent-foreground",
              )}
            >
              <span className="text-muted-foreground">#</span>
              {channel.name}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex flex-1 flex-col">
        <header className="flex h-12 items-center border-b px-4">
          <h1 className="text-sm font-medium">
            {activeChannel ? `# ${activeChannel.name}` : "No channel"}
          </h1>
        </header>
        <section className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-muted-foreground">No threads yet.</p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              Threads and messages land in the next slice.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
