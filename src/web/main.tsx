import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { App } from "./app";
import { SetupGate } from "./components/setup-gate";
import { InboxPage } from "./pages/inbox";
import { AgentsPage } from "./pages/agents";
import { ChannelPage } from "./pages/channel";
import { Onboarding } from "./pages/onboarding";
import "./index.css";

// Follow the system theme. A manual override can layer on later; the class
// stays the single switch the CSS keys off.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  document.documentElement.classList.toggle("dark", darkQuery.matches);
}
applyTheme();
darkQuery.addEventListener("change", applyTheme);

const router = createBrowserRouter([
  {
    path: "/onboarding",
    element: <Onboarding />,
  },
  {
    path: "/",
    element: (
      <SetupGate>
        <App />
      </SetupGate>
    ),
    children: [
      { index: true, element: <InboxPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "c/:channelId", element: <ChannelPage /> },
    ],
  },
]);

const root = createRoot(document.getElementById("root")!);
root.render(<RouterProvider router={router} />);
