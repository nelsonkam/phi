import type { ReactNode } from "react";
import { useAuthSession } from "@/web/lib/queries";

// Obtains the HttpOnly device cookie on loopback before the UI fetches
// attachment bytes. Remote clients without a bearer still render; uploads
// and previews then 401 until they present Authorization.
export function SessionGate({ children }: { children: ReactNode }) {
  const { isFetched } = useAuthSession();
  if (!isFetched) return null;
  return <>{children}</>;
}
