import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "./query-client";
import {
  createDefaultAgent,
  createThread,
  fetchAgent,
  fetchAgents,
  fetchChannels,
  fetchHarnessConfig,
  fetchHarnesses,
  fetchMessages,
  fetchSetupStatus,
  fetchThreads,
  sendMessage,
  updateAgent,
} from "./api";
import type { UpdateAgentInput } from "./api";
import type { Message, ServerFrame } from "@/shared/types";

// One query key namespace per API resource. Components never call the
// transport directly; they consume these hooks.
export const queryKeys = {
  channels: ["channels"] as const,
  agents: ["agents"] as const,
  harnesses: ["harnesses"] as const,
  setupStatus: ["setup", "status"] as const,
  harnessConfig: (harnessId: string) => ["harnesses", harnessId, "config"] as const,
  agent: (name: string) => ["agents", name] as const,
  channelThreads: (channelId: string) => ["channels", channelId, "threads"] as const,
  threadMessages: (threadId: string) => ["threads", threadId, "messages"] as const,
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

// Config listing is a live probe of the harness binary (it spawns a process),
// so it is enabled only on demand and never refetched behind the caller's back.
export function useHarnessConfig(harnessId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.harnessConfig(harnessId),
    queryFn: () => fetchHarnessConfig(harnessId),
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

export function useAgent(name: string) {
  return useQuery({
    queryKey: queryKeys.agent(name),
    queryFn: () => fetchAgent(name),
    retry: false,
  });
}

export function useUpdateAgent(name: string) {
  return useMutation({
    mutationFn: (input: UpdateAgentInput) => updateAgent(name, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agent(name) });
    },
  });
}

export function useThreads(channelId: string) {
  return useQuery({
    queryKey: queryKeys.channelThreads(channelId),
    queryFn: () => fetchThreads(channelId),
  });
}

export function useMessages(threadId: string) {
  return useQuery({
    queryKey: queryKeys.threadMessages(threadId),
    queryFn: () => fetchMessages(threadId),
  });
}

export function useCreateThread(channelId: string) {
  return useMutation({
    mutationFn: (content: string) => createThread(channelId, content),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelThreads(channelId),
      });
    },
  });
}

export function useSendMessage(threadId: string) {
  return useMutation({
    mutationFn: (content: string) => sendMessage(threadId, content),
    onSuccess: ({ message }) => {
      appendMessageToCache(message);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelThreads(message.channelId),
      });
    },
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

// Inserts a message into its thread's cached list, deduplicating by id (the
// sender's own POST response and the WebSocket delta both land here).
export function appendMessageToCache(message: Message): void {
  const queryKey = queryKeys.threadMessages(message.threadId);
  const cached = queryClient.getQueryData<{ messages: Message[] }>(queryKey);
  if (!cached) {
    // The frame can race the thread's first GET; refetch instead of dropping
    // the message on the floor.
    void queryClient.invalidateQueries({ queryKey });
    return;
  }
  if (cached.messages.some((m) => m.id === message.id)) return;
  queryClient.setQueryData(queryKey, {
    messages: [...cached.messages, message],
  });
}

// Applies a server delta frame to the query caches.
export function applyServerFrame(frame: ServerFrame): void {
  switch (frame.type) {
    case "message.appended":
      appendMessageToCache(frame.message);
      break;
    case "thread.updated":
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelThreads(frame.thread.channelId),
      });
      break;
    case "hello":
      // Deltas may have been missed while disconnected; refetch chat state.
      void queryClient.invalidateQueries({ queryKey: ["channels"] });
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      break;
  }
}
