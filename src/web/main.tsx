import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";
import { queryClient } from "./lib/query-client";
import { App } from "./app";
import { SetupGate } from "./components/setup-gate";
import { ActivityPage } from "./pages/activity";
import { AgentsPage } from "./pages/agents";
import { AgentDetailPage } from "./pages/agent-detail";
import { ChannelPage } from "./pages/channel";
import { Onboarding } from "./pages/onboarding";
import { applyTheme, getTheme } from "./lib/theme";
import "./index.css";

applyTheme(getTheme());

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
      { index: true, element: <ActivityPage /> },
      { path: "t/:threadId", element: <ActivityPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "agents/:name", element: <AgentDetailPage /> },
      { path: "c/:channelId", element: <ChannelPage /> },
      { path: "c/:channelId/t/:threadId", element: <ChannelPage /> },
    ],
  },
]);

const root = createRoot(document.getElementById("root")!);
root.render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
