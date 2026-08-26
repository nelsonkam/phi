import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import type { ReactNode } from "react";
import { fetchSetupStatus } from "@/web/lib/api";

// Blocks the app until the default agent exists. While the status request is
// in flight, render nothing to avoid flashing the app shell.
export function SetupGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"loading" | "ready" | "setup">(
    "loading",
  );

  useEffect(() => {
    fetchSetupStatus()
      .then(({ configured }) =>
        setStatus(configured ? "ready" : "setup"),
      )
      .catch(() => setStatus("setup"));
  }, []);

  if (status === "loading") return null;
  if (status === "setup") return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}
