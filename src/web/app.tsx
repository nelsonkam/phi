import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { Activity, Bot, Menu, Search, Settings } from "lucide-react";
import { SearchDialog } from "@/web/components/search-dialog";
import { ThemeToggle } from "@/web/components/theme-toggle";
import { activityWaitingCount } from "@/web/lib/activity";
import { applyServerFrame, useActivity, useChannels } from "@/web/lib/queries";
import { useMdUp } from "@/web/lib/use-md-up";
import { connectDeltaSocket, type ConnectionStatus } from "@/web/lib/ws";
import { cn } from "@/web/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

const MobileNavContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

export function App() {
  const { data } = useChannels();
  const { data: activity } = useActivity();
  const channels = data?.channels ?? [];
  const waitingCount = activityWaitingCount(activity?.pages);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const skipNavFocusRestore = useRef(false);
  const wasNavOpen = useRef(false);
  const mdUp = useMdUp();
  const wasMdUp = useRef(mdUp);
  const location = useLocation();
  const prevPathname = useRef(location.pathname);
  const drawerOpen = navOpen && !mdUp;

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
        if (drawerOpen) skipNavFocusRestore.current = true;
        setNavOpen(false);
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  useEffect(() => {
    if (prevPathname.current === location.pathname) return;
    prevPathname.current = location.pathname;
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (wasMdUp.current === mdUp) return;
    wasMdUp.current = mdUp;
    if (mdUp) setNavOpen(false);
  }, [mdUp]);

  useEffect(() => {
    if (!drawerOpen) return;
    const root = document.getElementById("app-nav");
    if (!root) return;
    const focusables = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
    focusables()[0]?.focus();

    // Capture phase so Escape closes the drawer before ThreadPanel stops a turn.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setNavOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0]!;
      const last = list.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [drawerOpen]);

  useEffect(() => {
    if (wasNavOpen.current && !navOpen && !mdUp) {
      if (!skipNavFocusRestore.current) {
        document
          .querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')
          ?.focus();
      }
      skipNavFocusRestore.current = false;
    }
    wasNavOpen.current = navOpen;
  }, [navOpen, mdUp]);

  return (
    <MobileNavContext.Provider value={{ open: navOpen, setOpen: setNavOpen }}>
      <div className="flex h-dvh overflow-hidden safe-area-insets">
        {drawerOpen && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close navigation"
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setNavOpen(false)}
          />
        )}
        <aside
          id="app-nav"
          aria-label="Sidebar"
          role={drawerOpen ? "dialog" : undefined}
          aria-modal={drawerOpen ? true : undefined}
          data-state={drawerOpen ? "open" : "closed"}
          inert={!mdUp && !navOpen}
          className={cn(
            "flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
            "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-72 max-md:max-w-[85vw] max-md:shadow-lg max-md:transition-transform max-md:duration-200 max-md:safe-area-insets",
            navOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full",
          )}
        >
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
              onClick={() => {
                skipNavFocusRestore.current = true;
                setSearchOpen(true);
                setNavOpen(false);
              }}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground md:py-1.5"
            >
              <Search className="size-4" />
              Search
              <kbd className="ml-auto hidden text-xs text-muted-foreground md:inline">
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

        <div className="flex min-h-0 min-w-0 flex-1 flex-col" inert={drawerOpen}>
          <Outlet />
        </div>

        <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      </div>
    </MobileNavContext.Provider>
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
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground md:py-1.5",
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
  titleExtra?: ReactNode;
  children: ReactNode;
}) {
  const nav = useContext(MobileNavContext);
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:gap-3 md:px-4">
        {nav && (
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
            aria-label="Open navigation"
            aria-expanded={nav.open}
            aria-controls="app-nav"
            onClick={() => nav.setOpen(true)}
          >
            <Menu className="size-5" />
          </button>
        )}
        <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
        {titleExtra}
      </header>
      <section className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {children}
      </section>
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
