import { dbPath, modelCachePath } from "@/core/paths";
import type { PhiStore } from "@/core/store/store";
import type { Message, MessageAuthor } from "@/shared/types";
import { chunkMessage } from "./chunk";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  type EmbeddingChunk,
  type MessageSearchContext,
  type MessageSearchResponse,
  type SearchMessagesInput,
  type VectorIndex,
} from "./types";
import { VectorWorkerClient } from "./vector-client";

const EMBEDDING_BATCH_SIZE = 32;
const DEFAULT_RESULT_LIMIT = 8;
const MAX_RESULT_LIMIT = 20;
const MIN_CANDIDATE_LIMIT = 50;
const RRF_K = 60;
const FTS_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "would",
  "you",
  "your",
]);

interface IndexableMessage {
  id: string;
  workspaceId: string;
  channelId: string;
  threadId: string;
  content: string;
}

interface PendingChunkRow {
  id: number;
  workspace_id: string;
  content: string;
  content_hash: string;
}

interface RankedChunk {
  score: number;
  matchedBy: Set<"keyword" | "semantic">;
  phraseMatch: boolean;
}

interface LexicalCandidate {
  chunkId: number;
  phraseMatch: boolean;
}

interface SearchChunkRow {
  chunk_id: number;
  chunk_content: string;
  message_id: string;
  workspace_id: string;
  channel_id: string;
  channel_name: string;
  thread_id: string;
  author: string;
  message_content: string;
  created_at: string;
}

export interface MessageSearchApi {
  search(
    workspaceId: string,
    input: SearchMessagesInput,
    context: MessageSearchContext,
  ): Promise<MessageSearchResponse>;
}

export class MessageSearch implements MessageSearchApi {
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  private pumpRequested = false;
  private pump: Promise<void> | null = null;
  private loggedVectorFailure = false;

  constructor(
    private readonly store: PhiStore,
    private readonly vector: VectorIndex,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.backfillLexicalIndex();
    this.resetIncompleteEmbeddings();
    this.unsubscribe = this.store.subscribe((change) => {
      if (change.type !== "message.appended") return;
      this.indexMessageLexically(change.message);
      this.requestEmbeddingPump();
    });
    this.requestEmbeddingPump();
  }

  async search(
    workspaceId: string,
    input: SearchMessagesInput,
    context: MessageSearchContext,
  ): Promise<MessageSearchResponse> {
    const query = input.query.trim();
    if (!query) throw new Error("query is required");
    const limit = Math.min(
      MAX_RESULT_LIMIT,
      Math.max(1, Math.trunc(input.limit ?? DEFAULT_RESULT_LIMIT)),
    );
    const candidateLimit = Math.max(MIN_CANDIDATE_LIMIT, limit * 5);
    const channelId = input.channel
      ? this.resolveChannelId(workspaceId, input.channel)
      : undefined;
    const currentThread = this.store.getThread(context.currentThreadId);
    const currentChannelName = currentThread
      ? this.store
          .listChannels(workspaceId)
          .find((channel) => channel.id === currentThread.channelId)?.name
      : undefined;
    const excludeThreadId = input.includeCurrentThread
      ? undefined
      : context.currentThreadId;
    const lexical = this.lexicalCandidates(
      workspaceId,
      query,
      channelId,
      excludeThreadId,
      input.author,
      candidateLimit,
    );
    let semantic: Awaited<ReturnType<VectorIndex["search"]>> = [];
    let semanticAvailable = true;
    try {
      semantic = await this.vector.search({
        workspaceId,
        query,
        channelId,
        excludeThreadId,
        author: input.author,
        limit: candidateLimit,
      });
      this.loggedVectorFailure = false;
    } catch (error) {
      semanticAvailable = false;
      if (!this.loggedVectorFailure) {
        console.error("Semantic message search unavailable", error);
        this.loggedVectorFailure = true;
      }
    }

    const ranked = new Map<number, RankedChunk>();
    lexical.forEach((match, index) => {
      ranked.set(match.chunkId, {
        score: 1 / (RRF_K + index + 1),
        matchedBy: new Set(["keyword"]),
        phraseMatch: match.phraseMatch,
      });
    });
    semantic.forEach((match, index) => {
      const candidate = ranked.get(match.chunkId);
      if (candidate) {
        candidate.score += 1 / (RRF_K + index + 1);
        candidate.matchedBy.add("semantic");
      } else {
        ranked.set(match.chunkId, {
          score: 1 / (RRF_K + index + 1),
          matchedBy: new Set(["semantic"]),
          phraseMatch: false,
        });
      }
    });

    const candidates = [...ranked.entries()];
    if (candidates.length === 0) {
      return { results: [], semanticAvailable };
    }
    const rows = this.hydrateChunks(candidates.map(([chunkId]) => chunkId));
    const rowByChunk = new Map(rows.map((row) => [row.chunk_id, row]));
    const resultByMessage = new Map<
      string,
      Omit<MessageSearchResponse["results"][number], "threadHitCount"> & {
        score: number;
        phraseMatch: boolean;
      }
    >();
    for (const [chunkId, rank] of candidates) {
      const row = rowByChunk.get(chunkId);
      if (!row) continue;
      if (excludeThreadId && row.thread_id === excludeThreadId) continue;
      if (input.author && row.author !== input.author) continue;
      const existing = resultByMessage.get(row.message_id);
      if (existing) {
        for (const kind of rank.matchedBy) {
          if (!existing.matchedBy.includes(kind)) existing.matchedBy.push(kind);
        }
        existing.score = Math.max(existing.score, rank.score);
        existing.phraseMatch ||= rank.phraseMatch;
        continue;
      }
      const result = {
        messageId: row.message_id,
        workspaceId: row.workspace_id,
        channel: row.channel_name,
        threadId: row.thread_id,
        author: row.author as MessageAuthor,
        content: row.message_content,
        snippet: row.chunk_content,
        createdAt: row.created_at,
        score: rank.score,
        phraseMatch: rank.phraseMatch,
        matchedBy: orderedMatchKinds(rank.matchedBy),
      };
      resultByMessage.set(row.message_id, result);
    }
    const rankedMessages = [...resultByMessage.values()].sort((a, b) => {
      const band = matchBand(a) - matchBand(b);
      if (band !== 0) return band;
      if (input.includeCurrentThread) {
        const aCurrent = a.threadId === context.currentThreadId;
        const bCurrent = b.threadId === context.currentThreadId;
        if (aCurrent !== bCurrent) return aCurrent ? 1 : -1;
      }
      if (b.score !== a.score) return b.score - a.score;
      const aSameChannel = a.channel === currentChannelName;
      const bSameChannel = b.channel === currentChannelName;
      if (aSameChannel !== bSameChannel) return bSameChannel ? 1 : -1;
      return b.createdAt.localeCompare(a.createdAt);
    });
    const threadHitCounts = new Map<string, number>();
    for (const result of rankedMessages) {
      threadHitCounts.set(
        result.threadId,
        (threadHitCounts.get(result.threadId) ?? 0) + 1,
      );
    }
    const seenThreads = new Set<string>();
    const results: MessageSearchResponse["results"] = [];
    for (const result of rankedMessages) {
      if (seenThreads.has(result.threadId)) continue;
      seenThreads.add(result.threadId);
      const { score: _score, phraseMatch: _phraseMatch, ...payload } = result;
      results.push({
        ...payload,
        threadHitCount: threadHitCounts.get(result.threadId)!,
      });
      if (results.length >= limit) break;
    }
    return { results, semanticAvailable };
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.vector.close();
  }

  async settled(): Promise<void> {
    while (this.pump) await this.pump;
  }

  private backfillLexicalIndex(): void {
    const query = this.store.db.prepare<
      {
        id: string;
        workspace_id: string;
        channel_id: string;
        thread_id: string;
        content: string;
      },
      []
    >(
      `SELECT m.id, m.workspace_id, m.channel_id, m.thread_id, m.content
       FROM messages m
       LEFT JOIN message_search_chunks c ON c.message_id = m.id
       WHERE c.id IS NULL AND trim(m.content) != ''
       ORDER BY m.seq LIMIT 250`,
    );
    while (true) {
      const rows = query.all();
      if (rows.length === 0) break;
      this.store.db.transaction(() => {
        for (const row of rows) {
          this.insertSearchChunks({
            id: row.id,
            workspaceId: row.workspace_id,
            channelId: row.channel_id,
            threadId: row.thread_id,
            content: row.content,
          });
        }
      })();
    }
    query.finalize();
  }

  private indexMessageLexically(message: Message): void {
    this.store.db.transaction(() => this.insertSearchChunks(message))();
  }

  private insertSearchChunks(message: IndexableMessage): void {
    this.store.db
      .query("DELETE FROM message_search_chunks WHERE message_id = ?")
      .run(message.id);
    const insert = this.store.db.prepare(
      `INSERT INTO message_search_chunks
         (message_id, workspace_id, channel_id, thread_id, chunk_index,
          content, content_hash, embedding_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );
    chunkMessage(message.content).forEach((chunk, index) => {
      insert.run(
        message.id,
        message.workspaceId,
        message.channelId,
        message.threadId,
        index,
        chunk.content,
        chunk.contentHash,
      );
    });
    insert.finalize();
  }

  private resetIncompleteEmbeddings(): void {
    this.store.db.run(
      `UPDATE message_search_chunks SET embedding_status = 'pending'
       WHERE embedding_status = 'processing'`,
    );
    this.store.db
      .query(
        `UPDATE message_search_chunks SET embedding_status = 'pending'
         WHERE embedding_status = 'ready' AND NOT EXISTS (
           SELECT 1 FROM message_embeddings e
           WHERE e.chunk_id = message_search_chunks.id
             AND e.model = ? AND e.dimensions = ?
             AND e.content_hash = message_search_chunks.content_hash
         )`,
      )
      .run(this.vector.model, this.vector.dimensions);
  }

  private requestEmbeddingPump(): void {
    if (this.stopped) return;
    this.pumpRequested = true;
    if (this.pump) return;
    this.pump = this.runEmbeddingPump().finally(() => {
      this.pump = null;
      if (this.pumpRequested && !this.stopped) this.requestEmbeddingPump();
    });
  }

  private async runEmbeddingPump(): Promise<void> {
    while (this.pumpRequested && !this.stopped) {
      this.pumpRequested = false;
      while (!this.stopped) {
        const rows = this.store.db
          .query<PendingChunkRow, [number]>(
            `SELECT id, workspace_id, content, content_hash
             FROM message_search_chunks
             WHERE embedding_status = 'pending'
             ORDER BY id LIMIT ?`,
          )
          .all(EMBEDDING_BATCH_SIZE);
        if (rows.length === 0) break;
        const chunks: EmbeddingChunk[] = rows.map((row) => ({
          id: row.id,
          workspaceId: row.workspace_id,
          content: row.content,
          contentHash: row.content_hash,
        }));
        const ids = JSON.stringify(chunks.map((chunk) => chunk.id));
        this.store.db
          .query(
            `UPDATE message_search_chunks SET embedding_status = 'processing'
             WHERE id IN (SELECT value FROM json_each(?))
               AND embedding_status = 'pending'`,
          )
          .run(ids);
        try {
          await this.vector.index(chunks);
        } catch (error) {
          this.store.db
            .query(
              `UPDATE message_search_chunks SET embedding_status = 'error'
               WHERE id IN (SELECT value FROM json_each(?))
                 AND embedding_status = 'processing'`,
            )
            .run(ids);
          console.error("Failed to index message embeddings", error);
          return;
        }
        await Bun.sleep(0);
      }
    }
  }

  private lexicalCandidates(
    workspaceId: string,
    query: string,
    channelId: string | undefined,
    excludeThreadId: string | undefined,
    author: "user" | "agent" | undefined,
    limit: number,
  ): LexicalCandidate[] {
    const queries = safeFtsQueries(query);
    if (!queries.and) return [];
    const seen = new Set<number>();
    const results: LexicalCandidate[] = [];
    const collect = (ftsQuery: string, phraseMatch: boolean) => {
      const clauses = [
        "message_search_fts MATCH ?",
        "c.workspace_id = ?",
        ...(channelId ? ["c.channel_id = ?"] : []),
        ...(excludeThreadId ? ["c.thread_id != ?"] : []),
        ...(author ? ["m.author = ?"] : []),
      ];
      const sql = `SELECT c.id
        FROM message_search_fts
        JOIN message_search_chunks c ON c.id = message_search_fts.rowid
        JOIN messages m ON m.id = c.message_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY bm25(message_search_fts) LIMIT ?`;
      const args: Array<string | number> = [
        ftsQuery,
        workspaceId,
        ...(channelId ? [channelId] : []),
        ...(excludeThreadId ? [excludeThreadId] : []),
        ...(author ? [author] : []),
        limit,
      ];
      const rows = this.store.db
        .query<{ id: number }, Array<string | number>>(sql)
        .all(...args);
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        results.push({ chunkId: row.id, phraseMatch });
      }
    };
    if (queries.phrase) collect(queries.phrase, true);
    collect(queries.and, false);
    return results.slice(0, limit);
  }

  private hydrateChunks(chunkIds: number[]): SearchChunkRow[] {
    return this.store.db
      .query<SearchChunkRow, [string]>(
        `SELECT c.id AS chunk_id, c.content AS chunk_content,
                m.id AS message_id, m.workspace_id, m.channel_id, ch.name AS channel_name,
                m.thread_id,
                m.author, m.content AS message_content, m.created_at
         FROM message_search_chunks c
         JOIN messages m ON m.id = c.message_id
         JOIN channels ch ON ch.id = m.channel_id
         WHERE c.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(chunkIds));
  }

  private resolveChannelId(workspaceId: string, channelName: string): string {
    const normalized = channelName.trim().toLocaleLowerCase();
    const channel = this.store
      .listChannels(workspaceId)
      .find((candidate) => candidate.name.toLocaleLowerCase() === normalized);
    if (!channel) throw new Error(`no channel named "${channelName}"`);
    return channel.id;
  }
}

export function createMessageSearch(
  store: PhiStore,
  root: string,
): MessageSearch {
  return new MessageSearch(
    store,
    new VectorWorkerClient({
      dbPath: dbPath(root),
      cacheDir: modelCachePath(root),
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  );
}

function safeFtsQueries(query: string): { and: string; phrase?: string } {
  const allTerms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const meaningfulTerms = allTerms.filter(
    (term) => !FTS_STOP_WORDS.has(term.toLowerCase()),
  );
  const terms = meaningfulTerms.length > 0 ? meaningfulTerms : allTerms;
  const quotedTerms = terms
    .slice(0, 20)
    .map((term) => `"${term.replaceAll('"', '""')}"`);
  return {
    and: quotedTerms.join(" AND "),
    ...(meaningfulTerms.length >= 2
      ? { phrase: `"${allTerms.slice(0, 20).join(" ")}"` }
      : {}),
  };
}

function orderedMatchKinds(
  kinds: Set<"keyword" | "semantic">,
): Array<"keyword" | "semantic"> {
  return (["keyword", "semantic"] as const).filter((kind) => kinds.has(kind));
}

function matchBand(result: {
  phraseMatch: boolean;
  matchedBy: Array<"keyword" | "semantic">;
}): number {
  const semantic = result.matchedBy.includes("semantic");
  if (result.phraseMatch) return semantic ? 0 : 1;
  if (result.matchedBy.includes("keyword")) return semantic ? 2 : 3;
  return 4;
}
