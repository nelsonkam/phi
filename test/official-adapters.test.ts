import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeWorkerAdapter } from "../src/workers/claude.ts";
import {
  codexCompletionEvent,
  CodexWorkerAdapter,
} from "../src/workers/codex.ts";
import { CursorWorkerAdapter } from "../src/workers/cursor.ts";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "phi-adapter-test-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  roots.length = 0;
});

describe("official SDK adapter capability contracts", () => {
  test("native mode adapters can defer authentication to their SDKs", () => {
    const directory = root();
    const workspace = join(directory, "workspace");
    mkdirSync(workspace);
    expect(
      new CursorWorkerAdapter({
        stateDir: join(directory, "cursor-native"),
        workspace,
        model: "composer-2.5",
        nativeCredentials: true,
      }).id,
    ).toBe("cursor");
    expect(new ClaudeWorkerAdapter({ nativeCredentials: true }).id).toBe(
      "claude",
    );
    expect(new CodexWorkerAdapter({}).id).toBe("codex");
  });

  test("Cursor exposes live events and external-run recovery, without claiming isolation", async () => {
    const directory = root();
    const workspace = join(directory, "workspace");
    mkdirSync(workspace);
    const adapter = new CursorWorkerAdapter({
      stateDir: join(directory, "cursor"),
      workspace,
      model: "composer-2.5",
      models: ["composer-2.5", "grok-4.6"],
    });
    expect(adapter.capabilities).toEqual({
      continuation: "sequential",
      cancellation: "remote",
    });
    expect(
      (await adapter.modelCatalog()).models.map((model) => model.id),
    ).toEqual(["composer-2.5", "grok-4.6"]);
  });

  test("Cursor isolated mode does not write to the native SDK login store", async () => {
    const directory = root();
    const workspace = join(directory, "workspace");
    mkdirSync(workspace);
    const adapter = new CursorWorkerAdapter({
      stateDir: join(directory, "cursor-isolated"),
      workspace,
      model: "composer-2.5",
      nativeCredentials: false,
    });
    expect((await adapter.status()).interactiveAuth).toBeFalse();
    await expect(adapter.authenticate()).rejects.toThrow(
      "isolated credential mode",
    );
  });

  test("Claude reports unsupported interrupted-run reconciliation honestly", async () => {
    const adapter = new ClaudeWorkerAdapter({ configDir: root() });
    expect(adapter.capabilities.continuation).toBe("sequential");
    expect(adapter.capabilities.cancellation).toBe("abort");
    expect(await adapter.reconcile()).toMatchObject({
      state: "unavailable",
    });
    const catalog = await adapter.modelCatalog();
    expect(catalog.models.map((model) => model.id)).toContain("haiku");
    expect(
      catalog.models.find((model) => model.id === "opus")?.effortLevels,
    ).toContain("max");
  });

  test("Codex exposes official reasoning summaries but no interrupted-turn lookup", async () => {
    const adapter = new CodexWorkerAdapter({
      codexHome: root(),
      model: "gpt-test-balanced",
      models: ["gpt-test-balanced", "gpt-test-deep"],
    });
    expect(adapter.capabilities.continuation).toBe("sequential");
    expect(adapter.capabilities.cancellation).toBe("abort");
    expect(await adapter.reconcile()).toMatchObject({
      state: "unavailable",
    });
    expect((await adapter.modelCatalog()).models).toHaveLength(2);
    expect(
      codexCompletionEvent("Useful final answer", {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
      }).summary,
    ).toBe("Useful final answer");
  });
});
