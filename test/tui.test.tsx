/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { PhiApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { PhiUiController } from "../src/ui/controller.ts";
import { PhiTuiView } from "../src/ui/tui.tsx";
import { testFixture } from "./helpers.ts";

test("conversation-first TUI submits input and keeps internals behind overlays", async () => {
  const fixture = testFixture();
  fixture.database.close();
  const app = await PhiApp.create(
    loadConfig({ workspace: fixture.workspace, runtimeDir: fixture.runtime }),
    { directCoordinator: true },
  );
  const controller = new PhiUiController(app);
  await controller.initialize();
  const setup = await createTestRenderer({ width: 90, height: 28 });
  try {
    await render(
      () => (
        <PhiTuiView controller={controller} workspace={fixture.workspace} />
      ),
      setup.renderer,
    );
    setup.renderer.start();
    await setup.renderOnce();
    const initial = setup.captureCharFrame();
    expect(initial).toContain("What would you like to build?");
    expect(initial).not.toContain("Harness status");
    expect(controller.snapshot().workers.map((worker) => worker.id)).toEqual([
      "fake",
      "cursor",
      "claude",
      "codex",
    ]);
    expect(setup.renderer.currentFocusedRenderable?.constructor.name).toBe(
      "InputRenderable",
    );

    await setup.mockInput.typeText("hello phi");
    await setup.waitForFrame((frame) => frame.includes("hello phi"));
    setup.mockInput.pressEnter();
    await setup.waitFor(() =>
      controller
        .snapshot()
        .conversation.some((entry) => entry.content === "hello phi"),
    );
    const conversationFrame = await setup.waitForFrame((frame) =>
      frame.includes("hello phi"),
    );
    expect(conversationFrame).not.toContain("You");

    const traceTime = new Date().toISOString();
    app.coordinatorTraces.upsert({
      id: "test-tool",
      kind: "tool",
      title: "tool · list_workers",
      content: "completed",
      createdAt: traceTime,
      state: "completed",
    });
    app.coordinatorTraces.upsert({
      id: "test-reasoning",
      kind: "reasoning",
      title: "reasoning",
      content: "Select a ready harness.",
      createdAt: traceTime,
      state: "completed",
    });
    app.coordinatorTraces.upsert({
      id: "test-output",
      kind: "output",
      title: "final output",
      content: "Turn finished.",
      createdAt: traceTime,
      state: "completed",
    });
    const detailsFrame = await setup.waitForFrame((frame) =>
      frame.includes("tool · list_workers"),
    );
    expect(detailsFrame).toContain("Select a ready harness.");
    expect(detailsFrame).toContain("final output");

    for (let index = 0; index < 12; index++)
      app.coordinatorTraces.upsert({
        id: `overflow-${index}`,
        kind: "tool",
        title: index === 11 ? "newest coordinator detail" : `detail ${index}`,
        content: `trace content ${index}`,
        createdAt: new Date(Date.now() + index + 1).toISOString(),
        state: "completed",
      });
    const scrolledFrame = await setup.waitForFrame((frame) =>
      frame.includes("newest coordinator detail"),
    );
    expect(scrolledFrame).not.toContain("What would you like to build?");

    setup.mockInput.pressKey("t", { ctrl: true });
    const hiddenFrame = await setup.waitForFrame(
      (frame) => !frame.includes("tool · list_workers"),
    );
    expect(hiddenFrame).not.toContain("Select a ready harness.");
    expect(hiddenFrame).not.toContain("final output");

    setup.mockInput.pressKey("a", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Activity details"));

    setup.mockInput.pressKey("p", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Commands"));
  } finally {
    setup.renderer.destroy();
    controller.dispose();
    await app.close();
  }
});
