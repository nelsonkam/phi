import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "./query-client";
import {
  createDefaultAgent,
  fetchAgents,
  fetchChannels,
  fetchHarnessModels,
  fetchHarnesses,
  fetchSetupStatus,
} from "./api";

// One query key namespace per API resource. Components never call the
// transport directly; they consume these hooks.
export const queryKeys = {
  channels: ["channels"] as const,
  agents: ["agents"] as const,
  harnesses: ["harnesses"] as const,
  setupStatus: ["setup", "status"] as const,
  harnessModels: (harnessId: string) => ["harnesses", harnessId, "models"] as const,
};

export function useChannels() {
  return useQuery({ queryKey: queryKeys.channels, queryFn: fetchChannels });
}

export function useAgents() {
  return useQuery({ queryKey: queryKeys.agents, queryFn: fetchAgents });
}

export function useHarnesses() {
  return useQuery({ queryKey: queryKeys.harnesses, queryFn: fetchHarnesses });
}

export function useSetupStatus() {
  return useQuery({ queryKey: queryKeys.setupStatus, queryFn: fetchSetupStatus });
}

// Model listing is a live probe of the harness binary (it spawns a process),
// so it is enabled only on demand and never refetched behind the caller's back.
export function useHarnessModels(harnessId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.harnessModels(harnessId),
    queryFn: () => fetchHarnessModels(harnessId),
    enabled,
    // A successful listing is stable for the session. An error result (not
    // installed, not logged in) goes stale immediately, so selecting the
    // harness again re-probes after the user fixes the cause.
    staleTime: (query) =>
      query.state.data?.error !== undefined ? 0 : Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useCreateDefaultAgent() {
  return useMutation({
    mutationFn: createDefaultAgent,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
      void queryClient.invalidateQueries({ queryKey: queryKeys.setupStatus });
    },
  });
}
