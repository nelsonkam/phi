import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  createExtensionRuntime,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Check = { name: string; details: string };

const checks: Check[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pass(name: string, details: string): void {
  checks.push({ name, details });
  console.log(`PASS ${name}: ${details}`);
}

const root = mkdtempSync(join(tmpdir(), "phi-bun-runtime-"));
const workspace = join(root, "workspace");
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
mkdirSync(workspace, { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

console.log(`Runtime: Bun ${Bun.version}`);
console.log(`Temporary state: ${root}`);

const piCli = Bun.spawnSync({
  cmd: [
    process.execPath,
    join(
      import.meta.dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
    "--version",
  ],
  stdout: "pipe",
  stderr: "pipe",
});
assert(
  piCli.exitCode === 0,
  `Pi CLI failed under Bun: ${piCli.stderr.toString()}`,
);
assert(
  piCli.stdout.toString().trim() === "0.84.2",
  "Pi CLI returned an unexpected version",
);
pass("Pi CLI entry", "published command entry launches under Bun");

// 1. Exercise the SQLite features Phi's control plane relies on.
const databasePath = join(root, "runtime.db");
const db = new Database(databasePath, { create: true, strict: true });
try {
  const journalMode = db.query("PRAGMA journal_mode = WAL").get() as Record<
    string,
    unknown
  >;
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed'))
    ) STRICT;
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      source_event_id TEXT NOT NULL REFERENCES events(id),
      dispatch_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL
    ) STRICT;
  `);

  const insertEvent = db.prepare(
    "INSERT INTO events (id, kind, status) VALUES (?, ?, ?)",
  );
  const insertJob = db.prepare(
    "INSERT INTO jobs (id, source_event_id, dispatch_key, status) VALUES (?, ?, ?, ?)",
  );

  const acceptJob = db.transaction(() => {
    insertEvent.run("event-1", "user_message", "pending");
    insertJob.run("job-1", "event-1", "dispatch:event-1:research", "queued");
  });
  acceptJob.immediate();

  let duplicateRejected = false;
  try {
    insertJob.run("job-2", "event-1", "dispatch:event-1:research", "queued");
  } catch {
    duplicateRejected = true;
  }
  assert(
    duplicateRejected,
    "UNIQUE dispatch_key did not reject a duplicate job",
  );

  const rollback = db.transaction(() => {
    insertEvent.run("event-rollback", "user_message", "pending");
    throw new Error("intentional rollback");
  });
  try {
    rollback.immediate();
  } catch {
    // Expected.
  }
  const rolledBack = db
    .query("SELECT id FROM events WHERE id = ?")
    .get("event-rollback");
  assert(rolledBack === null, "BEGIN IMMEDIATE transaction did not roll back");

  const persisted = db
    .query("SELECT status FROM jobs WHERE id = ?")
    .get("job-1") as { status: string } | null;
  assert(persisted?.status === "queued", "Committed job was not readable");
  pass(
    "bun:sqlite control plane",
    `WAL=${String(Object.values(journalMode)[0])}; STRICT tables, FK, uniqueness, immediate transaction, and rollback work`,
  );
} finally {
  db.close();
}

const reopened = new Database(databasePath, { readonly: true, strict: true });
try {
  const count = reopened.query("SELECT count(*) AS count FROM jobs").get() as {
    count: number;
  };
  assert(count.count === 1, "Database contents did not survive close/reopen");
  pass("bun:sqlite persistence", "database survives close/reopen");
} finally {
  reopened.close();
}

// 2. Exercise the Pi SDK under Bun without credentials or network calls.
assert(
  typeof createAgentSession === "function",
  "createAgentSession export is unavailable",
);
assert(
  typeof InteractiveMode === "function",
  "InteractiveMode export is unavailable",
);
pass("Pi SDK imports", "createAgentSession and InteractiveMode load under Bun");

const faux = registerFauxProvider();
let toolExecutions = 0;
const eventTypes: string[] = [];

const resourceLoader: ResourceLoader = {
  getExtensions: () => ({
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () =>
    "You are the Phi coordinator used by a runtime compatibility test.",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
});
const model = faux.getModel();
modelRuntime.registerProvider(model.provider, {
  baseUrl: model.baseUrl,
  api: model.api,
  models: [
    {
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      baseUrl: model.baseUrl,
    },
  ],
});
await modelRuntime.setRuntimeApiKey(model.provider, "local-faux-key");

faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("record_obligation", { key: "initial-ack" }),
    {
      stopReason: "toolUse",
    },
  ),
  fauxAssistantMessage("obligation recorded"),
]);

const { session } = await createAgentSession({
  cwd: workspace,
  agentDir,
  model,
  modelRuntime,
  noTools: "builtin",
  customTools: [
    {
      name: "record_obligation",
      label: "Record obligation",
      description: "Record a deterministic test obligation.",
      parameters: Type.Object({ key: Type.String() }),
      execute: async (_toolCallId, params) => {
        const input = params as { key: string };
        toolExecutions += 1;
        return {
          content: [{ type: "text", text: `recorded:${input.key}` }],
          details: { key: input.key },
        };
      },
    },
  ],
  resourceLoader,
  sessionManager: SessionManager.create(workspace, sessionDir),
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  }),
});

const unsubscribe = session.subscribe((event) => eventTypes.push(event.type));
try {
  await session.prompt("Record the initial acknowledgement.");
  assert(
    toolExecutions === 1,
    `Expected one custom tool execution, got ${toolExecutions}`,
  );
  assert(
    eventTypes.includes("tool_execution_start"),
    "Pi did not emit tool_execution_start",
  );
  assert(
    eventTypes.includes("tool_execution_end"),
    "Pi did not emit tool_execution_end",
  );
  assert(eventTypes.includes("agent_settled"), "Pi did not emit agent_settled");
  assert(
    session.messages.length >= 4,
    "Expected user, tool-call, tool-result, and final response messages",
  );
  pass(
    "Pi agent loop",
    "credential-free faux model completed a tool loop and emitted lifecycle events",
  );
} finally {
  unsubscribe();
  session.dispose();
  faux.unregister();
}

const sessionFiles = readdirSync(sessionDir).filter((name) =>
  name.endsWith(".jsonl"),
);
assert(
  sessionFiles.length === 1,
  `Expected one persisted Pi JSONL session, got ${sessionFiles.length}`,
);
const jsonl = readFileSync(join(sessionDir, sessionFiles[0]!), "utf8");
assert(
  jsonl.includes("Record the initial acknowledgement"),
  "Persisted session is missing the prompt",
);
assert(
  jsonl.includes("record_obligation"),
  "Persisted session is missing the tool call",
);
pass(
  "Pi session durability",
  "JSONL contains the prompt, tool call, tool result, and response",
);

const { session: resumedSession } = await createAgentSession({
  cwd: workspace,
  agentDir,
  model,
  modelRuntime,
  noTools: "builtin",
  resourceLoader,
  sessionManager: SessionManager.continueRecent(workspace, sessionDir),
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  }),
});
try {
  assert(
    resumedSession.sessionFile === join(sessionDir, sessionFiles[0]!),
    "Resume opened a different session file",
  );
  assert(
    resumedSession.messages.length >= 4,
    "Resume did not restore the prior message history",
  );
  pass(
    "Pi session resume",
    "continueRecent restored the same JSONL session and message history",
  );
} finally {
  resumedSession.dispose();
}

console.log(`\n${checks.length} checks passed.`);
