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
  retryTurn,
  sendMessage,
  updateAgent,
} from "./api";
import type { UpdateAgentInput } from "./api";
import type { Channel, Message, ServerFrame } from "@/shared/types";

interface TurnPresenceState {
  ready: boolean;
  agentsByThread: Record<string, string>;
}

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
  turnPresence: ["threads", "turn-presence"] as const,
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

export function useThreadTurn(threadId: string): {
  ready: boolean;
  agent: string | null;
} {
  const { data } = useQuery<TurnPresenceState>({
    queryKey: queryKeys.turnPresence,
    queryFn: async () => ({ ready: false, agentsByThread: {} }),
    initialData: { ready: false, agentsByThread: {} },
    enabled: false,
  });
  return {
    ready: data.ready,
    agent: data.agentsByThread[threadId] ?? null,
  };
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
    // The user's message appears the moment they hit send; the POST response
    // (or the WebSocket frame, whichever lands first) replaces it with the
    // committed row, and a failure rolls it back.
    onMutate: async (content) => {
      const queryKey = queryKeys.threadMessages(threadId);
      await queryClient.cancelQueries({ queryKey });
      const cached = queryClient.getQueryData<{ messages: Message[] }>(queryKey);
      if (!cached) return {};
      const optimistic: Message = {
        id: `optimistic-${crypto.randomUUID()}`,
        workspaceId: "",
        channelId: "",
        threadId,
        author: "user",
        kind: "message",
        content,
        metadata: { optimistic: true },
        seq: (cached.messages.at(-1)?.seq ?? 0) + 1,
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueryData(queryKey, {
        messages: [...cached.messages, optimistic],
      });
      return { optimisticId: optimistic.id };
    },
    onError: (_error, _content, context) => {
      if (context?.optimisticId) {
        removeMessageFromCache(threadId, context.optimisticId);
      }
    },
    onSuccess: ({ message }, _content, context) => {
      if (context?.optimisticId) {
        removeMessageFromCache(threadId, context.optimisticId);
      }
      appendMessageToCache(message);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelThreads(message.channelId),
      });
    },
  });
}

// Re-runs the thread's last user message after a failed turn. No cache
// changes here: the resulting turn frames and messages arrive over the
// socket like any other turn's.
export function useRetryTurn(threadId: string) {
  return useMutation({ mutationFn: () => retryTurn(threadId) });
}

export function useCreateDefaultAgent() {
  return useMutation({
    mutationFn: createDefaultAgent,
    onSuccess: (result) => {
      // The mutation resolves with { ok: false } instead of throwing, so this
      // fires on failures too. Write the cache synchronously on success:
      // Onboarding navigates to "/" right after the mutation, and an
      // invalidate-triggered refetch would still be in flight when SetupGate
      // reads the stale { configured: false } and bounces back to onboarding.
      if (!result.ok) return;
      queryClient.setQueryData(queryKeys.setupStatus, { configured: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    },
  });
}

function removeMessageFromCache(threadId: string, messageId: string): void {
  const queryKey = queryKeys.threadMessages(threadId);
  const cached = queryClient.getQueryData<{ messages: Message[] }>(queryKey);
  if (!cached) return;
  queryClient.setQueryData(queryKey, {
    messages: cached.messages.filter((m) => m.id !== messageId),
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
    case "channel.updated":
      queryClient.setQueryData<{ channels: Channel[] }>(
        queryKeys.channels,
        (current = { channels: [] }) => ({
          channels: [
            ...current.channels.filter(
              (channel) => channel.id !== frame.channel.id,
            ),
            frame.channel,
          ].sort((left, right) => left.name.localeCompare(right.name)),
        }),
      );
      break;
    case "message.appended":
      appendMessageToCache(frame.message);
      break;
    case "thread.updated":
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelThreads(frame.thread.channelId),
      });
      break;
    case "thread.turn":
      queryClient.setQueryData<TurnPresenceState>(
        queryKeys.turnPresence,
        (current = { ready: true, agentsByThread: {} }) => {
          const agentsByThread = { ...current.agentsByThread };
          if (frame.active && frame.agent) {
            agentsByThread[frame.threadId] = frame.agent;
          } else {
            delete agentsByThread[frame.threadId];
          }
          return { ready: true, agentsByThread };
        },
      );
      break;
    case "hello":
      queryClient.setQueryData<TurnPresenceState>(queryKeys.turnPresence, {
        ready: true,
        agentsByThread: Object.fromEntries(
          frame.activeTurns.flatMap((turn) =>
            turn.active && turn.agent ? [[turn.threadId, turn.agent]] : [],
          ),
        ),
      });
      // Deltas may have been missed while disconnected; refetch chat state.
      void queryClient.invalidateQueries({ queryKey: ["channels"] });
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      break;
  }
}
