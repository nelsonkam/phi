import type { Channel } from "../../shared/types";

// The only file (with ws.ts) that knows the transport. Everything else
// consumes typed results, so a future mobile client mirrors just these two.

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export function fetchChannels(): Promise<{ channels: Channel[] }> {
  return get("/channels");
}
