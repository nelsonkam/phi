import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";
import { Activity, Bot, Search, Settings } from "lucide-react";
import { SearchDialog } from "@/web/components/search-dialog";
import { ThemeToggle } from "@/web/components/theme-toggle";
import { activityWaitingCount } from "@/web/lib/activity";
import { applyServerFrame, useActivity, useChannels } from "@/web/lib/queries";
import { connectDeltaSocket, type ConnectionStatus } from "@/web/lib/ws";
import { cn } from "@/web/lib/utils";

export function App() {
  const { data } = useChannels();
  const { data: activity } = useActivity();
  const channels = data?.channels ?? [];
  const waitingCount = activityWaitingCount(activity?.pages);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    return connectDeltaSocket({
      onFrame: applyServerFrame,
      onStatus: setStatus,
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
          <ThemeToggle />
        </header>
        <nav className="flex-1 overflow-y-auto p-2">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Search className="size-4" />
            Search
            <kbd className="ml-auto text-xs text-muted-foreground">
              {isMac() ? "⌘K" : "Ctrl K"}
            </kbd>
          </button>
          <SidebarLink to="/" end>
            <Activity className="size-4" />
            Activity
            {waitingCount > 0 && (
              <span
                aria-label={
                  waitingCount === 1
                    ? "1 thread waiting"
                    : `${waitingCount} threads waiting`
                }
                className="ml-auto rounded-full bg-sky-600 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white"
              >
                {waitingCount}
              </span>
            )}
          </SidebarLink>
          <SidebarLink to="/agents">
            <Bot className="size-4" />
            Agents
          </SidebarLink>
          <SidebarLink to="/settings">
            <Settings className="size-4" />
            Settings
          </SidebarLink>

          <p className="mt-4 px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Channels
          </p>
          {channels.map((channel) => (
            <SidebarLink key={channel.id} to={`/c/${channel.id}`}>
              <span className="w-4 text-center text-muted-foreground">#</span>
              {channel.name}
            </SidebarLink>
          ))}
        </nav>
      </aside>

      <Outlet />

      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}

function isMac(): boolean {
  return /Mac|iP/.test(navigator.platform);
}

function SidebarLink({
  to,
  end,
  children,
}: {
  to: string;
  end?: boolean;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          isActive && "bg-accent text-accent-foreground",
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function Page({
  title,
  titleExtra,
  children,
}: {
  title: string;
  titleExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <h1 className="text-sm font-medium">{title}</h1>
        {titleExtra}
      </header>
      <section className="flex min-h-0 flex-1 flex-col">{children}</section>
    </main>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
