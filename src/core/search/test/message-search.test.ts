import { expect, test } from "bun:test";
import { MessageSearch } from "../message-search";
import type {
  EmbeddingChunk,
  SemanticMatch,
  SemanticSearchInput,
  VectorIndex,
} from "../types";
import { PhiStore } from "@/core/store/store";
import { tempDir } from "@/testing/tmpdir";

class FakeVectorIndex implements VectorIndex {
  readonly model = "fake-embedding-model";
  readonly dimensions = 3;
  readonly chunks = new Map<number, EmbeddingChunk>();

  constructor(private readonly store: PhiStore) {}

  async index(chunks: EmbeddingChunk[]): Promise<void> {
    for (const chunk of chunks) this.chunks.set(chunk.id, chunk);
    this.store.db
      .prepare(
        `UPDATE message_search_chunks SET embedding_status = 'ready'
         WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .run(JSON.stringify(chunks.map((chunk) => chunk.id)));
  }

  async search(input: SemanticSearchInput): Promise<SemanticMatch[]> {
    const terms = input.query.toLowerCase().split(/\s+/u);
    return [...this.chunks.values()]
      .filter((chunk) => chunk.workspaceId === input.workspaceId)
      .map((chunk) => ({
        chunkId: chunk.id,
        score: terms.some((term) => chunk.content.toLowerCase().includes(term))
          ? 1
          : 0.25,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit);
  }

  close(): void {}
}

function fixture() {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const first = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "The deployment uses capability tokens for agent authentication.",
  });
  const vector = new FakeVectorIndex(store);
  const search = new MessageSearch(store, vector);
  search.start();
  return { store, workspace, channel, first, vector, search };
}

test("backfills existing messages and indexes new messages immediately for FTS", async () => {
  const { store, workspace, first, search } = fixture();
  await search.settled();

  const existing = await search.search(workspace.id, {
    query: "capability tokens",
  });
  expect(existing.results[0]).toMatchObject({
    messageId: first.message.id,
    matchedBy: ["keyword", "semantic"],
  });

  const appended = store.appendMessage(first.thread.id, {
    author: "agent",
    kind: "message",
    content: "The regression is tracked under PHI-4821.",
    metadata: { agent: "default" },
  });
  const immediate = await search.search(workspace.id, { query: "PHI-4821" });
  expect(
    immediate.results.some((result) => result.messageId === appended.id),
  ).toBe(true);

  await search.settled();
  await search.close();
  store.close();
});

test("semantic candidates recover related messages without a lexical match", async () => {
  const { store, workspace, first, search } = fixture();
  const related = store.appendMessage(first.thread.id, {
    author: "agent",
    kind: "message",
    content:
      "The open conversation panel makes the page extend below the viewport.",
    metadata: { agent: "default" },
  });
  await search.settled();

  const response = await search.search(workspace.id, {
    query: "vertical scrolling",
    channel: "GENERAL",
    limit: 5,
  });
  expect(response.semanticAvailable).toBe(true);
  expect(
    response.results.some((result) => result.messageId === related.id),
  ).toBe(true);
  expect(response.results.every((result) => result.channel === "general")).toBe(
    true,
  );

  await expect(
    search.search(workspace.id, {
      query: "vertical scrolling",
      channel: "missing",
    }),
  ).rejects.toThrow('no channel named "missing"');

  await search.close();
  store.close();
});

test("long messages are split into independently indexed chunks", async () => {
  const { store, workspace, first, search } = fixture();
  const long = store.appendMessage(first.thread.id, {
    author: "agent",
    kind: "message",
    content: Array.from({ length: 700 }, (_, index) => `word${index}`).join(
      " ",
    ),
    metadata: { agent: "default" },
  });
  await search.settled();

  const count = store.db
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM message_search_chunks WHERE message_id = ?",
    )
    .get(long.id)!.count;
  expect(count).toBe(3);
  const result = await search.search(workspace.id, { query: "word650" });
  expect(result.results.some((item) => item.messageId === long.id)).toBe(true);

  await search.close();
  store.close();
});
