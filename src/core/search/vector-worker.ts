import { Database } from "bun:sqlite";
import { env, pipeline } from "@huggingface/transformers";
import type {
  EmbeddingChunk,
  SemanticMatch,
  SemanticSearchInput,
} from "./types";
import type {
  VectorWorkerRequest,
  VectorWorkerResponse,
  VectorWorkerResult,
} from "./vector-protocol";

const LOAD_BATCH_SIZE = 1_000;
const MAX_HOT_WORKSPACES = 2;

interface ExtractorOutput {
  data: Float32Array;
}

type Extractor = (
  input: string | string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<ExtractorOutput>;

interface DisposableExtractor extends Extractor {
  dispose?: () => Promise<void>;
}

interface WorkspaceVectorSlab {
  ids: Float64Array;
  vectors: Float32Array;
  channelCodes: Uint32Array;
  channelCodeById: Map<string, number>;
  threadIds: string[];
  authors: string[];
}

interface VectorRow {
  id: number;
  channel_id: string;
  thread_id: string;
  author: string;
  embedding: Uint8Array;
}

let db: Database | null = null;
let model = "";
let dimensions = 0;
let extractor: DisposableExtractor | null = null;
const slabs = new Map<string, WorkspaceVectorSlab>();

async function initialize(
  request: Extract<VectorWorkerRequest, { type: "initialize" }>,
) {
  env.cacheDir = request.cacheDir;
  model = request.model;
  dimensions = request.dimensions;
  db = new Database(request.dbPath, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 5000;");
}

async function getExtractor(): Promise<DisposableExtractor> {
  if (!extractor) {
    extractor = (await pipeline("feature-extraction", model, {
      dtype: "q8",
    })) as unknown as DisposableExtractor;
  }
  return extractor;
}

async function indexChunks(chunks: EmbeddingChunk[]): Promise<void> {
  if (!db) throw new Error("vector worker is not initialized");
  if (chunks.length === 0) return;
  const embed = await getExtractor();
  const output = await embed(
    chunks.map((chunk) => chunk.content),
    { pooling: "mean", normalize: true },
  );
  if (output.data.length !== chunks.length * dimensions) {
    throw new Error(
      `embedding model returned ${output.data.length} values for ${chunks.length} chunks`,
    );
  }

  const save = db.prepare(
    `INSERT INTO message_embeddings
       (chunk_id, model, dimensions, content_hash, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chunk_id) DO UPDATE SET
       model = excluded.model,
       dimensions = excluded.dimensions,
       content_hash = excluded.content_hash,
       embedding = excluded.embedding,
       created_at = excluded.created_at`,
  );
  const markReady = db.prepare(
    `UPDATE message_search_chunks SET embedding_status = 'ready'
     WHERE id = ? AND content_hash = ?`,
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const byteOffset = output.data.byteOffset + index * dimensions * 4;
      const bytes = new Uint8Array(
        output.data.buffer,
        byteOffset,
        dimensions * 4,
      );
      save.run(chunk.id, model, dimensions, chunk.contentHash, bytes, now);
      markReady.run(chunk.id, chunk.contentHash);
    }
  })();
  save.finalize();
  markReady.finalize();

  for (const workspaceId of new Set(chunks.map((chunk) => chunk.workspaceId))) {
    slabs.delete(workspaceId);
  }
}

async function semanticSearch(
  input: SemanticSearchInput,
): Promise<SemanticMatch[]> {
  const slab = loadWorkspace(input.workspaceId);
  const channelCode = input.channelId
    ? slab.channelCodeById.get(input.channelId)
    : undefined;
  if (input.channelId && channelCode === undefined) return [];

  const embed = await getExtractor();
  const output = await embed(input.query, { pooling: "mean", normalize: true });
  if (output.data.length !== dimensions) {
    throw new Error(`query embedding has ${output.data.length} dimensions`);
  }

  const matches: SemanticMatch[] = [];
  for (let rowIndex = 0; rowIndex < slab.ids.length; rowIndex++) {
    if (
      channelCode !== undefined &&
      slab.channelCodes[rowIndex] !== channelCode
    ) {
      continue;
    }
    if (
      input.excludeThreadId &&
      slab.threadIds[rowIndex] === input.excludeThreadId
    ) {
      continue;
    }
    if (input.author && slab.authors[rowIndex] !== input.author) continue;
    const vectorOffset = rowIndex * dimensions;
    let score = 0;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      score +=
        output.data[dimension]! * slab.vectors[vectorOffset + dimension]!;
    }
    const match = { chunkId: slab.ids[rowIndex]!, score };
    if (matches.length < input.limit) {
      matches.push(match);
      if (matches.length === input.limit) {
        matches.sort((a, b) => a.score - b.score);
      }
    } else if (score > matches[0]!.score) {
      matches[0] = match;
      matches.sort((a, b) => a.score - b.score);
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}

function loadWorkspace(workspaceId: string): WorkspaceVectorSlab {
  if (!db) throw new Error("vector worker is not initialized");
  const cached = slabs.get(workspaceId);
  if (cached) {
    slabs.delete(workspaceId);
    slabs.set(workspaceId, cached);
    return cached;
  }

  const { count } = db
    .query<{ count: number }, [string, string, number]>(
      `SELECT COUNT(*) AS count
       FROM message_embeddings e
       JOIN message_search_chunks c ON c.id = e.chunk_id
       WHERE c.workspace_id = ? AND e.model = ? AND e.dimensions = ?
         AND e.content_hash = c.content_hash`,
    )
    .get(workspaceId, model, dimensions)!;
  const ids = new Float64Array(count);
  const vectors = new Float32Array(count * dimensions);
  const channelCodes = new Uint32Array(count);
  const channelCodeById = new Map<string, number>();
  const threadIds = new Array<string>(count);
  const authors = new Array<string>(count);
  const query = db.prepare<VectorRow, [string, string, number, number, number]>(
    `SELECT c.id, c.channel_id, c.thread_id, m.author, e.embedding
     FROM message_embeddings e
     JOIN message_search_chunks c ON c.id = e.chunk_id
     JOIN messages m ON m.id = c.message_id
     WHERE c.workspace_id = ? AND e.model = ? AND e.dimensions = ?
       AND e.content_hash = c.content_hash AND c.id > ?
     ORDER BY c.id LIMIT ?`,
  );

  let loaded = 0;
  let lastId = 0;
  while (loaded < count) {
    let rows = query.all(
      workspaceId,
      model,
      dimensions,
      lastId,
      LOAD_BATCH_SIZE,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const vector =
        row.embedding.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
          ? new Float32Array(
              row.embedding.buffer,
              row.embedding.byteOffset,
              dimensions,
            )
          : new Float32Array(row.embedding.slice().buffer);
      ids[loaded] = row.id;
      vectors.set(vector, loaded * dimensions);
      let code = channelCodeById.get(row.channel_id);
      if (code === undefined) {
        code = channelCodeById.size + 1;
        channelCodeById.set(row.channel_id, code);
      }
      channelCodes[loaded] = code;
      threadIds[loaded] = row.thread_id;
      authors[loaded] = row.author;
      loaded++;
      lastId = row.id;
    }
    rows = [];
    if (loaded % 10_000 === 0) Bun.gc(false);
  }
  query.finalize();

  const slab =
    loaded === count
      ? { ids, vectors, channelCodes, channelCodeById, threadIds, authors }
      : {
          ids: ids.slice(0, loaded),
          vectors: vectors.slice(0, loaded * dimensions),
          channelCodes: channelCodes.slice(0, loaded),
          channelCodeById,
          threadIds: threadIds.slice(0, loaded),
          authors: authors.slice(0, loaded),
        };
  slabs.set(workspaceId, slab);
  while (slabs.size > MAX_HOT_WORKSPACES) {
    const oldest = slabs.keys().next().value as string | undefined;
    if (!oldest) break;
    slabs.delete(oldest);
  }
  return slab;
}

async function handle(
  request: VectorWorkerRequest,
): Promise<VectorWorkerResult> {
  switch (request.type) {
    case "initialize":
      await initialize(request);
      return;
    case "index":
      await indexChunks(request.chunks);
      return;
    case "search":
      return semanticSearch(request.input);
    case "close":
      await extractor?.dispose?.();
      extractor = null;
      slabs.clear();
      db?.close();
      db = null;
      return;
  }
}

let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<VectorWorkerRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    let response: VectorWorkerResponse;
    try {
      const result = await handle(request);
      response = { id: request.id, ok: true, result };
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    self.postMessage(response);
    if (request.type === "close") self.close();
  });
};
