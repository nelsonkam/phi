import type {
  EmbeddingChunk,
  SemanticMatch,
  SemanticSearchInput,
  VectorIndex,
} from "./types";
import type {
  VectorWorkerRequest,
  VectorWorkerResponse,
  VectorWorkerResult,
} from "./vector-protocol";

interface VectorWorkerClientOptions {
  dbPath: string;
  cacheDir: string;
  model: string;
  dimensions: number;
}

interface PendingRequest {
  resolve: (value: VectorWorkerResult) => void;
  reject: (error: Error) => void;
}

type VectorWorkerCommand = VectorWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

export class VectorWorkerClient implements VectorIndex {
  readonly model: string;
  readonly dimensions: number;
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private closing: Promise<void> | null = null;
  private failure: Error | null = null;
  private readonly ready: Promise<VectorWorkerResult>;

  constructor(options: VectorWorkerClientOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    const workerEntry = import.meta.url.endsWith(".js")
      ? "./core/search/vector-worker.js"
      : "./vector-worker.ts";
    this.worker = new Worker(new URL(workerEntry, import.meta.url));
    this.worker.onmessage = (event: MessageEvent<VectorWorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    };
    this.worker.onerror = (event) => {
      this.failure = new Error(event.message || "vector worker failed");
      this.failAll(this.failure);
    };
    this.ready = this.request({
      type: "initialize",
      dbPath: options.dbPath,
      cacheDir: options.cacheDir,
      model: options.model,
      dimensions: options.dimensions,
    });
  }

  async index(chunks: EmbeddingChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.ready;
    await this.request({ type: "index", chunks });
  }

  async search(input: SemanticSearchInput): Promise<SemanticMatch[]> {
    await this.ready;
    return (await this.request({ type: "search", input })) as SemanticMatch[];
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.failure) {
      this.closed = true;
      this.worker.terminate();
      return Promise.resolve();
    }
    this.closing = this.request({ type: "close" })
      .then(() => undefined)
      .finally(() => {
        this.closed = true;
        this.worker.terminate();
        this.failAll(new Error("vector worker closed"));
      });
    return this.closing;
  }

  private request(request: VectorWorkerCommand): Promise<VectorWorkerResult> {
    if (this.closed) return Promise.reject(new Error("vector worker closed"));
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id } as VectorWorkerRequest);
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
