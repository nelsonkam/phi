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
    const viewportParaphrase =
      input.query.toLowerCase() === "vertical scrolling";
    return [...this.chunks.values()]
      .filter((chunk) => chunk.workspaceId === input.workspaceId)
      .map((chunk) => ({
        chunkId: chunk.id,
        score:
          terms.some((term) => chunk.content.toLowerCase().includes(term)) ||
          (viewportParaphrase &&
            chunk.content.toLowerCase().includes("below the viewport"))
            ? 1
            : 0.25,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit);
  }

  close(): void {}
}

class SearchUnavailableVectorIndex extends FakeVectorIndex {
  override async search(): Promise<SemanticMatch[]> {
    throw new Error("embedding worker unavailable");
  }
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

function searchFromAnotherThread(
  search: MessageSearch,
  workspaceId: string,
  input: Parameters<MessageSearch["search"]>[1],
) {
  return search.search(workspaceId, input, {
    currentThreadId: "thread-not-in-fixture",
  });
}

test("backfills existing messages and indexes new messages immediately for FTS", async () => {
  const { store, workspace, first, search } = fixture();
  await search.settled();

  const existing = await searchFromAnotherThread(search, workspace.id, {
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
  const immediate = await searchFromAnotherThread(search, workspace.id, {
    query: "PHI-4821",
  });
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

  const response = await searchFromAnotherThread(search, workspace.id, {
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
    searchFromAnotherThread(search, workspace.id, {
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
  const result = await searchFromAnotherThread(search, workspace.id, {
    query: "word650",
  });
  expect(result.results.some((item) => item.messageId === long.id)).toBe(true);

  await search.close();
  store.close();
});

test("excludes the current thread unless explicitly included", async () => {
  const { store, workspace, channel, first, search } = fixture();
  const historical = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "The orchard release marker is cobalt.",
  });
  store.appendMessage(first.thread.id, {
    author: "agent",
    kind: "message",
    content: "The orchard release marker is cobalt.",
    metadata: { agent: "default" },
  });
  await search.settled();

  const excluded = await search.search(
    workspace.id,
    { query: "orchard release marker" },
    { currentThreadId: first.thread.id },
  );
  expect(excluded.results.map((result) => result.threadId)).toEqual([
    historical.thread.id,
  ]);

  const included = await search.search(
    workspace.id,
    { query: "orchard release marker", includeCurrentThread: true },
    { currentThreadId: first.thread.id },
  );
  expect(included.results.map((result) => result.threadId)).toEqual([
    historical.thread.id,
    first.thread.id,
  ]);

  await search.close();
  store.close();
});

test("requires all lexical terms and ranks a phrase ahead of single-term semantic hits", async () => {
  const { store, workspace, channel, search } = fixture();
  const exact = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Make the configurable git remote available.",
  });
  store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "The MCP remote is ready.",
  });
  await search.settled();

  const response = await searchFromAnotherThread(search, workspace.id, {
    query: "configurable git remote",
    limit: 1,
  });
  expect(response.results[0]!.threadId).toBe(exact.thread.id);
  expect(response.results[0]!.matchedBy).toEqual(["keyword", "semantic"]);

  await search.close();
  store.close();
});

test("preserves interior stop words in phrase matching", async () => {
  const { store, workspace, channel, search } = fixture();
  const intactPhrase = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "This is the state of the art deployment.",
  });
  store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "This state art deployment omits the connecting words.",
  });
  await search.settled();

  const response = await searchFromAnotherThread(search, workspace.id, {
    query: "state of the art",
    limit: 1,
  });
  expect(response.results[0]!.threadId).toBe(intactPhrase.thread.id);

  await search.close();
  store.close();
});

test("collapses matching messages by thread and reports the distinct hit count", async () => {
  const { store, workspace, channel, search } = fixture();
  const crowded = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Juniper handshake decision one.",
  });
  store.appendMessage(crowded.thread.id, {
    author: "agent",
    kind: "message",
    content: "Juniper handshake decision two.",
    metadata: { agent: "default" },
  });
  await search.settled();

  const response = await searchFromAnotherThread(search, workspace.id, {
    query: "juniper handshake decision",
  });
  const hits = response.results.filter(
    (result) => result.threadId === crowded.thread.id,
  );
  expect(hits).toHaveLength(1);
  expect(hits[0]!.threadHitCount).toBe(2);
  expect(hits[0]).not.toHaveProperty("score");

  await search.close();
  store.close();
});

test("filters results by author", async () => {
  const { store, workspace, channel, search } = fixture();
  const userThread = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Violet protocol recap from the user.",
  });
  const agentThread = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Unrelated root.",
  });
  store.appendMessage(agentThread.thread.id, {
    author: "agent",
    kind: "message",
    content: "Violet protocol recap from the agent.",
    metadata: { agent: "default" },
  });
  await search.settled();

  const response = await searchFromAnotherThread(search, workspace.id, {
    query: "violet protocol recap",
    author: "user",
  });
  expect(response.results.map((result) => result.threadId)).toContain(
    userThread.thread.id,
  );
  expect(response.results.every((result) => result.author === "user")).toBe(
    true,
  );

  await search.close();
  store.close();
});

test("returns lexical hits when semantic search is unavailable", async () => {
  const store = new PhiStore(tempDir());
  const workspace = store.defaultWorkspace();
  const channel = store.listChannels(workspace.id)[0]!;
  const historical = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: "Saffron capability boundary decision.",
  });
  const search = new MessageSearch(
    store,
    new SearchUnavailableVectorIndex(store),
  );
  search.start();
  await search.settled();

  const response = await search.search(
    workspace.id,
    { query: "saffron capability boundary" },
    { currentThreadId: "another-thread" },
  );
  expect(response.semanticAvailable).toBe(false);
  expect(response.results[0]).toMatchObject({
    threadId: historical.thread.id,
    matchedBy: ["keyword"],
  });

  await search.close();
  store.close();
});
