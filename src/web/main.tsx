import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { App } from "./app";
import { InboxPage } from "./pages/inbox";
import { AgentsPage } from "./pages/agents";
import { ChannelPage } from "./pages/channel";
import "./index.css";

document.documentElement.classList.add("dark");

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <InboxPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "c/:channelId", element: <ChannelPage /> },
    ],
  },
]);

const root = createRoot(document.getElementById("root")!);
root.render(<RouterProvider router={router} />);
