import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";
import { Bot, Inbox } from "lucide-react";
import { ThemeToggle } from "@/web/components/theme-toggle";
import { applyServerFrame, useChannels } from "@/web/lib/queries";
import { connectDeltaSocket, type ConnectionStatus } from "@/web/lib/ws";
import { cn } from "@/web/lib/utils";

export function App() {
  const { data } = useChannels();
  const channels = data?.channels ?? [];
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    return connectDeltaSocket({
      onFrame: applyServerFrame,
      onStatus: setStatus,
    });
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
          <SidebarLink to="/" end>
            <Inbox className="size-4" />
            Inbox
          </SidebarLink>
          <SidebarLink to="/agents">
            <Bot className="size-4" />
            Agents
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
    </div>
  );
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
