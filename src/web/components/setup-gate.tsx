import { Navigate } from "react-router";
import type { ReactNode } from "react";
import { useSetupStatus } from "@/web/lib/queries";

// Blocks the app until the default agent exists. While the status request is
// in flight, render nothing to avoid flashing the app shell.
export function SetupGate({ children }: { children: ReactNode }) {
  const { data, isError } = useSetupStatus();

  if (!data && !isError) return null;
  if (isError || !data?.configured) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}
