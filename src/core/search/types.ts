import type { MessageAuthor } from "@/shared/types";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

export interface SearchMessagesInput {
  query: string;
  channel?: string;
  limit?: number;
  includeCurrentThread?: boolean;
  author?: "user" | "agent";
}

export interface MessageSearchContext {
  currentThreadId: string;
}

export interface MessageSearchResult {
  messageId: string;
  workspaceId: string;
  channel: string;
  threadId: string;
  author: MessageAuthor;
  content: string;
  snippet: string;
  createdAt: string;
  matchedBy: Array<"keyword" | "semantic">;
  /** Total distinct matching messages represented for this thread. */
  threadHitCount: number;
}

export interface MessageSearchResponse {
  results: MessageSearchResult[];
  semanticAvailable: boolean;
}

export interface EmbeddingChunk {
  id: number;
  workspaceId: string;
  content: string;
  contentHash: string;
}

export interface SemanticSearchInput {
  workspaceId: string;
  query: string;
  channelId?: string;
  excludeThreadId?: string;
  author?: "user" | "agent";
  limit: number;
}

export interface SemanticMatch {
  chunkId: number;
  score: number;
}

export interface VectorIndex {
  readonly model: string;
  readonly dimensions: number;
  index(chunks: EmbeddingChunk[]): Promise<void>;
  search(input: SemanticSearchInput): Promise<SemanticMatch[]>;
  close(): Promise<void> | void;
}
