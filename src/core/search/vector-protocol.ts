import type {
  EmbeddingChunk,
  SemanticMatch,
  SemanticSearchInput,
} from "./types";

export type VectorWorkerRequest =
  | {
      id: number;
      type: "initialize";
      dbPath: string;
      cacheDir: string;
      model: string;
      dimensions: number;
    }
  | { id: number; type: "index"; chunks: EmbeddingChunk[] }
  | { id: number; type: "search"; input: SemanticSearchInput }
  | { id: number; type: "close" };

export type VectorWorkerResult = undefined | SemanticMatch[];

export type VectorWorkerResponse =
  | { id: number; ok: true; result?: VectorWorkerResult }
  | { id: number; ok: false; error: string };
