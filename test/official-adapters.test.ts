import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeWorkerAdapter } from "../src/workers/claude.ts";
import { CodexWorkerAdapter } from "../src/workers/codex.ts";
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

  test("Cursor exposes live events and external-run recovery, without claiming isolation", () => {
    const directory = root();
    const workspace = join(directory, "workspace");
    mkdirSync(workspace);
    const adapter = new CursorWorkerAdapter({
      stateDir: join(directory, "cursor"),
      workspace,
      model: "composer-2.5",
    });
    expect(adapter.capabilities).toEqual({
      watch: "live",
      continuation: "sequential",
      cancellation: "remote",
      reconciliation: "external_run_id",
      reasoning: "summary",
      toolEvents: true,
      needsInput: false,
      isolation: "none",
    });
  });

  test("Claude reports unsupported interrupted-run reconciliation honestly", async () => {
    const adapter = new ClaudeWorkerAdapter({ configDir: root() });
    expect(adapter.capabilities.reasoning).toBe("none");
    expect(await adapter.reconcile()).toMatchObject({
      state: "unavailable",
    });
  });

  test("Codex exposes official reasoning summaries but no interrupted-turn lookup", async () => {
    const adapter = new CodexWorkerAdapter({ codexHome: root() });
    expect(adapter.capabilities.reasoning).toBe("summary");
    expect(adapter.capabilities.isolation).toBe("optional_sdk_sandbox");
    expect(await adapter.reconcile()).toMatchObject({
      state: "unavailable",
    });
  });
});
