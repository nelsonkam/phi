/** @jsxImportSource @opentui/solid */
import type { InputRenderable, SelectOption } from "@opentui/core";
import { createCliRenderer } from "@opentui/core";
import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import type { PhiApp } from "../app.ts";
import type { CoordinatorTraceEntry } from "../coordinator/trace.ts";
import {
  PhiUiController,
  type ConversationEntry,
  type PhiUiSnapshot,
} from "./controller.ts";

const paletteOptions: SelectOption[] = [
  {
    name: "Coordinator details",
    description: "Toggle coordinator tool calls, reasoning, and final output",
    value: "coordinator-details",
  },
  {
    name: "Activity details",
    description: "Toggle internal job and worker activity",
    value: "activity",
  },
  {
    name: "Harness status",
    description: "Inspect available harnesses and authentication readiness",
    value: "harnesses",
  },
  {
    name: "Log in to Cursor",
    description: "Start the official Cursor SDK browser login",
    value: "cursor-login",
  },
  {
    name: "Refresh harness status",
    description: "Recheck local SDK authentication state",
    value: "refresh",
  },
  {
    name: "Quit Phi",
    description: "Close the TUI while preserving durable state",
    value: "quit",
  },
];

export interface PhiTuiViewProps {
  controller: PhiUiController;
  workspace: string;
}

type TranscriptEntry =
  | { type: "message"; entry: ConversationEntry }
  | { type: "trace"; entry: CoordinatorTraceEntry };

export function PhiTuiView(props: PhiTuiViewProps) {
  const renderer = useRenderer();
  const [snapshot, setSnapshot] = createSignal<PhiUiSnapshot>(
    props.controller.snapshot(),
  );
  const [draft, setDraft] = createSignal("");
  const [palette, setPalette] = createSignal(false);
  const [showCoordinatorDetails, setShowCoordinatorDetails] =
    createSignal(true);
  const [drawer, setDrawer] = createSignal<"activity" | "harnesses" | null>(
    null,
  );
  const [submitting, setSubmitting] = createSignal(false);
  let input: InputRenderable | undefined;

  const closeOverlay = () => {
    if (palette()) setPalette(false);
    else if (drawer()) setDrawer(null);
  };

  onMount(() => {
    const unsubscribe = props.controller.subscribe(setSnapshot);
    onCleanup(unsubscribe);
    input?.focus();
  });

  useKeyboard((event) => {
    if (event.ctrl && event.name === "p") {
      event.preventDefault();
      setPalette((value) => !value);
    } else if (event.ctrl && event.name === "a") {
      event.preventDefault();
      setDrawer((value) => (value === "activity" ? null : "activity"));
    } else if (event.ctrl && event.name === "t") {
      event.preventDefault();
      setShowCoordinatorDetails((value) => !value);
    } else if (event.name === "escape") {
      event.preventDefault();
      closeOverlay();
    } else if (event.ctrl && event.name === "c") {
      event.preventDefault();
      renderer.destroy();
    }
  });

  const submit = async (value: string) => {
    if (submitting() || !value.trim()) return;
    setSubmitting(true);
    setDraft("");
    if (input) input.value = "";
    try {
      await props.controller.submit(value);
    } finally {
      setSubmitting(false);
      input?.focus();
    }
  };

  const choosePalette = async (option: SelectOption | null) => {
    const action = String(option?.value ?? "");
    setPalette(false);
    if (action === "coordinator-details")
      setShowCoordinatorDetails((value) => !value);
    else if (action === "activity")
      setDrawer((value) => (value === "activity" ? null : "activity"));
    else if (action === "harnesses")
      setDrawer((value) => (value === "harnesses" ? null : "harnesses"));
    else if (action === "cursor-login") {
      setDrawer("harnesses");
      await props.controller.loginCursor();
    } else if (action === "refresh") {
      setDrawer("harnesses");
      await props.controller.refreshWorkers();
    } else if (action === "quit") renderer.destroy();
    input?.focus();
  };

  const recentActivities = createMemo(() => snapshot().activities.slice(0, 8));
  const transcript = createMemo<TranscriptEntry[]>(() => {
    const entries: TranscriptEntry[] = snapshot().conversation.map((entry) => ({
      type: "message",
      entry,
    }));
    if (showCoordinatorDetails())
      entries.push(
        ...snapshot().coordinatorTraces.map((entry) => ({
          type: "trace" as const,
          entry,
        })),
      );
    return entries.sort(
      (left, right) =>
        left.entry.createdAt.localeCompare(right.entry.createdAt) ||
        left.entry.id.localeCompare(right.entry.id),
    );
  });
  const activityText = createMemo(() =>
    recentActivities().length
      ? recentActivities()
          .map((activity) => `${activity.title} · ${activity.detail}`)
          .join("\n")
      : "No activity yet.",
  );
  const harnessText = createMemo(() =>
    snapshot()
      .workers.map((worker) => {
        const marker =
          worker.readiness === "ready"
            ? "●"
            : worker.readiness === "login_required"
              ? "○"
              : "◐";
        const models = worker.modelCatalog.models
          .map((model) =>
            model.id === worker.modelCatalog.defaultModel
              ? `${model.id} (default)`
              : model.id,
          )
          .join(", ");
        return `${marker} ${worker.id} · ${worker.detail}\n  models: ${models || "provider default only"}`;
      })
      .join("\n"),
  );

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor="#0d1117"
      paddingX={1}
    >
      <box height={2} flexDirection="row" justifyContent="space-between">
        <text fg="#f0f6fc">
          <strong>Phi</strong> · {props.workspace}
        </text>
        <text
          fg={snapshot().status.startsWith("Ready") ? "#3fb950" : "#d29922"}
        >
          {snapshot().status}
        </text>
      </box>

      <scrollbox
        flexGrow={1}
        scrollY
        stickyScroll
        stickyStart="bottom"
        contentOptions={{ flexDirection: "column", paddingRight: 1 }}
      >
        <For
          each={transcript()}
          fallback={
            <box flexDirection="column" paddingTop={1}>
              <text fg="#f0f6fc">What would you like to build?</text>
              <text fg="#8b949e" wrapMode="word">
                Phi coordinates the work and reports results here. Internal
                harness activity stays out of the way unless you open it.
              </text>
            </box>
          }
        >
          {(item) =>
            item.type === "message" ? (
              <box
                width="100%"
                backgroundColor={
                  item.entry.role === "user" ? "#16263a" : "#0d1117"
                }
                paddingX={1}
                paddingY={1}
                marginBottom={1}
              >
                <text
                  content={item.entry.content}
                  fg="#f0f6fc"
                  wrapMode="word"
                  selectable
                />
              </box>
            ) : (
              <box
                width="100%"
                backgroundColor="#202a36"
                paddingX={1}
                paddingY={1}
                marginBottom={1}
                flexDirection="column"
              >
                <text fg="#c9d1d9">
                  <strong>{item.entry.title}</strong>
                  {item.entry.state === "running" ? " · running" : ""}
                </text>
                <text
                  content={item.entry.content}
                  fg="#aebbc8"
                  wrapMode="word"
                  selectable
                />
              </box>
            )
          }
        </For>
      </scrollbox>

      <box
        height={snapshot().notice ? 3 : 0}
        visible={Boolean(snapshot().notice)}
        border={["top"]}
        borderColor="#30363d"
        paddingY={1}
      >
        <text content={snapshot().notice ?? ""} fg="#d29922" wrapMode="word" />
      </box>

      <box
        height={drawer() === "activity" ? 10 : 0}
        visible={drawer() === "activity"}
        border
        borderStyle="rounded"
        borderColor="#30363d"
        title=" Activity details · Esc to close "
        flexDirection="column"
        paddingX={1}
      >
        <text content={activityText()} fg="#8b949e" wrapMode="word" />
      </box>

      <box
        height={drawer() === "harnesses" ? 10 : 0}
        visible={drawer() === "harnesses"}
        border
        borderStyle="rounded"
        borderColor="#30363d"
        title=" Harness status · Esc to close "
        flexDirection="column"
        paddingX={1}
      >
        <text content={harnessText()} fg="#8b949e" wrapMode="word" />
      </box>

      <box height={1} justifyContent="space-between" flexDirection="row">
        <text fg="#6e7681">
          Ctrl+P commands · Ctrl+T {showCoordinatorDetails() ? "hide" : "show"}
          coordinator
        </text>
        <text fg="#6e7681">Enter send · Ctrl+C quit</text>
      </box>
      <box
        height={3}
        border
        borderStyle="rounded"
        borderColor="#30363d"
        focusedBorderColor="#58a6ff"
        paddingX={1}
      >
        <input
          ref={(element) => {
            input = element;
          }}
          value={draft()}
          focused={!palette()}
          placeholder={submitting() ? "Sending…" : "Type a request…"}
          textColor="#f0f6fc"
          focusedTextColor="#f0f6fc"
          backgroundColor="#0d1117"
          focusedBackgroundColor="#0d1117"
          onInput={setDraft}
          onSubmit={() => void submit(draft())}
        />
      </box>

      <box
        visible={palette()}
        position="absolute"
        top="15%"
        left="15%"
        width="70%"
        height={14}
        zIndex={100}
        border
        borderStyle="rounded"
        borderColor="#58a6ff"
        backgroundColor="#161b22"
        title=" Commands · Esc to close "
        padding={1}
      >
        <select
          focused={palette()}
          width="100%"
          height="100%"
          options={paletteOptions}
          wrapSelection
          selectedBackgroundColor="#1f6feb"
          selectedTextColor="#ffffff"
          descriptionColor="#8b949e"
          onSelect={(_index, option) => void choosePalette(option)}
        />
      </box>
    </box>
  );
}

export async function runPhiTui(app: PhiApp): Promise<void> {
  const done = Promise.withResolvers<void>();
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    backgroundColor: "#0d1117",
    onDestroy: () => done.resolve(),
  });
  const controller = new PhiUiController(app);
  await controller.initialize();
  try {
    await render(
      () => (
        <PhiTuiView
          controller={controller}
          workspace={app.config.paths.workspace}
        />
      ),
      renderer,
    );
    await done.promise;
  } finally {
    controller.dispose();
    if (!renderer.isDestroyed) renderer.destroy();
  }
}
