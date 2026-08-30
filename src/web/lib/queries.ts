import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { queryClient } from "./query-client";
import {
  createDefaultAgent,
  createDocComment,
  createThread,
  fetchActivity,
  markAllRead,
  fetchAgent,
  fetchAgents,
  fetchAuthSession,
  fetchChannels,
  fetchDocComments,
  fetchDocCommentSummary,
  fetchGitRemoteSettings,
  fetchHarnessConfig,
  fetchHarnesses,
  fetchMessages,
  fetchSetupStatus,
  fetchThread,
  fetchThreads,
  markThreadRead,
  retryTurn,
  cancelTurn,
  searchMessages,
  sendMessage,
  updateAgent,
  updateGitRemoteSettings,
  updateThreadStatus,
  updateThreadOutcome,
} from "./api";
import type { UpdateAgentInput } from "./api";
import { ACTIVITY_PAGE_SIZE, activityNextCursor } from "./activity";
import type {
  Channel,
  Message,
  ServerFrame,
  Attachment,
  Thread,
} from "@/shared/types";

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
  authSession: ["auth", "session"] as const,
  gitRemoteSettings: ["settings", "git-remote"] as const,
  harnessConfig: (harnessId: string) => ["harnesses", harnessId, "config"] as const,
  agent: (name: string) => ["agents", name] as const,
  channelThreads: (channelId: string) => ["channels", channelId, "threads"] as const,
  threadMessages: (threadId: string) => ["threads", threadId, "messages"] as const,
  turnPresence: ["threads", "turn-presence"] as const,
  activity: ["activity"] as const,
  thread: (threadId: string) => ["threads", threadId] as const,
  docComments: (channelId: string, rootId: string, path: string) =>
    ["channels", channelId, "doc-comments", rootId, path] as const,
  messageSearch: (query: string) => ["search", query] as const,
  docCommentSummary: (channelId: string, parentThreadId?: string) =>
    parentThreadId
      ? (["channels", channelId, "doc-comments", "summary", parentThreadId] as const)
      : (["channels", channelId, "doc-comments", "summary"] as const),
};

// The Activity feed: one row per thread, newest latest-message first,
// paginated by that message's workspace-global seq. Realtime frames
// invalidate rather than patch the cache — the query is one cheap local
// read, and refetching sidesteps hand-maintaining row order and unread
// counts across pages.
export function useActivity() {
  return useInfiniteQuery({
    queryKey: queryKeys.activity,
    queryFn: ({ pageParam }) => fetchActivity(pageParam, ACTIVITY_PAGE_SIZE),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: activityNextCursor,
  });
}

// Advances the thread's read watermark. Fired when a thread is opened (and
// as new messages land while it stays open), so it must be quiet: no
// spinners, and a failure just leaves the row unread.
export function useMarkThreadRead() {
  return useMutation({
    mutationFn: ({ threadId }: { threadId: string; channelId: string }) =>
      markThreadRead(threadId),
    onSuccess: (_data, { channelId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.activity });
      // Channel rows gate the waiting dot on unreadCount, so that channel's
      // thread list must refetch too.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelThreads(channelId),
      });
      invalidateDocComments(channelId);
    },
  });
}

// One server-side bulk write: every thread in the workspace, not just the
// pages the feed has loaded so far.
export function useMarkAllRead() {
  return useMutation({
    mutationFn: () => markAllRead(),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.activity });
      // Touches every thread, so every channel's list (keyed under
      // ["channels", id, "threads"]) may have dots to clear.
      void queryClient.invalidateQueries({ queryKey: ["channels"] });
    },
  });
}

export function useChannels() {
  return useQuery({ queryKey: queryKeys.channels, queryFn: fetchChannels });
}

// Search-as-you-type: previous results stay visible while the next query is
// in flight so the palette never flashes empty between keystrokes.
export function useMessageSearch(query: string) {
  return useQuery({
    queryKey: queryKeys.messageSearch(query),
    queryFn: () => searchMessages(query),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
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

export function useAuthSession() {
  return useQuery({
    queryKey: queryKeys.authSession,
    queryFn: fetchAuthSession,
    staleTime: Infinity,
    retry: false,
  });
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

export function useGitRemoteSettings() {
  return useQuery({
    queryKey: queryKeys.gitRemoteSettings,
    queryFn: fetchGitRemoteSettings,
    refetchInterval: (query) =>
      query.state.data?.health.status === "pending" ? 1000 : false,
  });
}

export function useUpdateGitRemoteSettings() {
  return useMutation({
    mutationFn: updateGitRemoteSettings,
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.gitRemoteSettings, data);
    },
  });
}

export function useThreads(channelId: string) {
  return useQuery({
    queryKey: queryKeys.channelThreads(channelId),
    queryFn: () => fetchThreads(channelId),
  });
}

export function useMessages(threadId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.threadMessages(threadId ?? ""),
    queryFn: () => fetchMessages(threadId!),
    enabled: Boolean(threadId),
  });
}

export function useThread(threadId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.thread(threadId ?? ""),
    queryFn: () => fetchThread(threadId!),
    enabled: Boolean(threadId),
    retry: false,
  });
}

export function useDocComments(
  channelId: string | undefined,
  rootId: string | undefined,
  path: string | undefined,
) {
  return useQuery({
    queryKey: queryKeys.docComments(channelId ?? "", rootId ?? "", path ?? ""),
    queryFn: () => fetchDocComments(channelId!, rootId!, path!),
    enabled: Boolean(channelId && rootId && path),
  });
}

export function useDocCommentSummary(
  channelId: string | undefined,
  parentThreadId?: string,
) {
  return useQuery({
    queryKey: queryKeys.docCommentSummary(channelId ?? "", parentThreadId),
    queryFn: () => fetchDocCommentSummary(channelId!, parentThreadId),
    enabled: Boolean(channelId),
  });
}

export function useCreateDocComment(channelId: string) {
  return useMutation({
    mutationFn: (
      input: Parameters<typeof createDocComment>[1],
    ) => createDocComment(channelId, input),
    onSuccess: () => {
      invalidateDocComments(channelId);
    },
  });
}

export function useUpdateThreadStatus(channelId: string) {
  return useMutation({
    mutationFn: (input: { threadId: string; status: Thread["status"] }) =>
      updateThreadStatus(input.threadId, input.status),
    onSuccess: () => {
      invalidateDocComments(channelId);
    },
  });
}

export function useUpdateThreadOutcome(channelId: string, threadId: string) {
  return useMutation({
    mutationFn: (outcome: Thread["outcome"]) =>
      updateThreadOutcome(threadId, outcome),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelThreads(channelId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(threadId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.activity });
    },
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
    mutationFn: (input: { content: string; attachmentIds?: string[] }) =>
      createThread(channelId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelThreads(channelId),
      });
    },
  });
}

export function useSendMessage(threadId: string) {
  return useMutation({
    mutationFn: (input: {
      content: string;
      attachmentIds?: string[];
      attachments?: Attachment[];
    }) =>
      sendMessage(threadId, {
        content: input.content,
        attachmentIds: input.attachmentIds,
      }),
    // The user's message appears the moment they hit send; the POST response
    // (or the WebSocket frame, whichever lands first) replaces it with the
    // committed row, and a failure rolls it back.
    onMutate: async (input) => {
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
        content: input.content,
        metadata: {
          optimistic: true,
          ...(input.attachments?.length
            ? { attachments: input.attachments }
            : {}),
        },
        seq: (cached.messages.at(-1)?.seq ?? 0) + 1,
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueryData(queryKey, {
        messages: [...cached.messages, optimistic],
      });
      return { optimisticId: optimistic.id };
    },
    onError: (_error, _input, context) => {
      if (context?.optimisticId) {
        removeMessageFromCache(threadId, context.optimisticId);
      }
    },
    onSuccess: ({ message }, _input, context) => {
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

export function useCancelTurn(threadId: string) {
  return useMutation({ mutationFn: () => cancelTurn(threadId) });
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.activity });
      invalidateDocComments(frame.message.channelId);
      break;
    case "thread.updated":
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelThreads(frame.thread.channelId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.activity });
      invalidateDocComments(frame.thread.channelId);
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.activity });
      break;
  }
}

function invalidateDocComments(channelId: string): void {
  void queryClient.invalidateQueries({
    queryKey: ["channels", channelId, "doc-comments"],
  });
}
