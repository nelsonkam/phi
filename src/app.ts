import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PhiConfig } from "./config.ts";
import { CoordinatorLoop } from "./coordinator/loop.ts";
import {
  DirectCoordinatorRuntime,
  PiCoordinatorRuntime,
  type CoordinatorRuntime,
} from "./coordinator/runtime.ts";
import { CoordinatorTools } from "./coordinator/tools.ts";
import { TurnContext } from "./coordinator/turn-context.ts";
import { PhiDatabase } from "./db/database.ts";
import { PhiStore } from "./db/store.ts";
import { CancellationService } from "./jobs/cancellation.ts";
import { CompletionService } from "./jobs/completion.ts";
import { FollowUpDispatcher } from "./jobs/followups.ts";
import { RecoveryService } from "./jobs/recovery.ts";
import { JobScheduler } from "./jobs/scheduler.ts";
import { OutboxDispatcher } from "./messaging/dispatcher.ts";
import {
  ConsoleTransport,
  type MessageTransport,
} from "./messaging/transport.ts";
import { ensureRuntimeDirectories } from "./paths.ts";
import { GitService } from "./workspace/git.ts";
import { WorkerAdapterRegistry } from "./workers/adapter.ts";
import { ClaudeWorkerAdapter } from "./workers/claude.ts";
import { CodexWorkerAdapter } from "./workers/codex.ts";
import { CursorWorkerAdapter } from "./workers/cursor.ts";
import { FakeWorkerAdapter } from "./workers/fake.ts";

function credential(path: string, envName: string): string | undefined {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  return process.env[envName];
}

export class PhiApp {
  readonly database: PhiDatabase;
  readonly store: PhiStore;
  readonly adapters = new WorkerAdapterRegistry();
  readonly git: GitService;
  readonly scheduler: JobScheduler;
  readonly coordinatorLoop: CoordinatorLoop;
  readonly outbox: OutboxDispatcher;
  readonly followUps: FollowUpDispatcher;
  private readonly coordinator: CoordinatorRuntime;

  private constructor(
    readonly config: PhiConfig,
    services: {
      database: PhiDatabase;
      store: PhiStore;
      git: GitService;
      scheduler: JobScheduler;
      coordinatorLoop: CoordinatorLoop;
      outbox: OutboxDispatcher;
      followUps: FollowUpDispatcher;
      coordinator: CoordinatorRuntime;
      adapters: WorkerAdapterRegistry;
    },
  ) {
    this.database = services.database;
    this.store = services.store;
    this.git = services.git;
    this.scheduler = services.scheduler;
    this.coordinatorLoop = services.coordinatorLoop;
    this.outbox = services.outbox;
    this.followUps = services.followUps;
    this.coordinator = services.coordinator;
    for (const adapter of services.adapters.list())
      this.adapters.register(adapter);
  }

  static async create(
    config: PhiConfig,
    options: { directCoordinator?: boolean; transport?: MessageTransport } = {},
  ): Promise<PhiApp> {
    ensureRuntimeDirectories(config.paths);
    const database = new PhiDatabase(config.paths.database);
    database.migrate();
    const store = new PhiStore(database);
    const git = new GitService(config.paths.workspace);
    try {
      await git.ensureInitialized();
    } catch (error) {
      database.close();
      throw error;
    }
    const workspace = store.registerWorkspace(config.paths.workspace);
    const adapters = new WorkerAdapterRegistry();
    adapters.register(new FakeWorkerAdapter());
    const isolatedCredentials = config.credentialMode === "isolated";
    const cursorApiKey = isolatedCredentials
      ? credential(
          join(config.paths.credentialsDir, "cursor-api-key"),
          "CURSOR_API_KEY",
        )
      : undefined;
    adapters.register(
      new CursorWorkerAdapter({
        stateDir: join(config.paths.workerSessionsDir, "cursor"),
        workspace: config.paths.workspace,
        model: config.cursorModel,
        nativeCredentials: !isolatedCredentials,
        ...(cursorApiKey ? { apiKey: cursorApiKey } : {}),
      }),
    );
    const claudeApiKey = isolatedCredentials
      ? credential(
          join(config.paths.credentialsDir, "anthropic-api-key"),
          "ANTHROPIC_API_KEY",
        )
      : undefined;
    const claudeModel = process.env.PHI_CLAUDE_MODEL;
    adapters.register(
      new ClaudeWorkerAdapter({
        ...(isolatedCredentials
          ? { configDir: join(config.paths.credentialsDir, "claude") }
          : {}),
        nativeCredentials: !isolatedCredentials,
        ...(claudeApiKey ? { apiKey: claudeApiKey } : {}),
        ...(claudeModel ? { model: claudeModel } : {}),
      }),
    );
    const codexApiKey = isolatedCredentials
      ? credential(
          join(config.paths.credentialsDir, "openai-api-key"),
          "OPENAI_API_KEY",
        )
      : undefined;
    const codexModel = process.env.PHI_CODEX_MODEL;
    adapters.register(
      new CodexWorkerAdapter({
        ...(isolatedCredentials
          ? { codexHome: join(config.paths.credentialsDir, "codex") }
          : {}),
        ...(codexApiKey ? { apiKey: codexApiKey } : {}),
        ...(codexModel ? { model: codexModel } : {}),
      }),
    );
    const outbox = new OutboxDispatcher(
      store,
      options.transport ?? new ConsoleTransport(),
    );
    const followUps = new FollowUpDispatcher(store, adapters);
    const cancellation = new CancellationService(store, adapters);
    let coordinatorLoop: CoordinatorLoop | null = null;
    const completion = new CompletionService(store, git, workspace.id, () =>
      coordinatorLoop?.wake(),
    );
    const scheduler = new JobScheduler({
      store,
      adapters,
      completion,
      git,
      workspace: config.paths.workspace,
      concurrency: config.concurrency,
    });
    const turn = new TurnContext();
    const tools = new CoordinatorTools({
      store,
      workspaceId: workspace.id,
      workspace: config.paths.workspace,
      turn,
      scheduler,
      followUps,
      cancellation,
      outbox,
    });
    const coordinator = options.directCoordinator
      ? new DirectCoordinatorRuntime(tools)
      : await PiCoordinatorRuntime.create({
          paths: config.paths,
          workspace: config.paths.workspace,
          tools,
          credentialMode: config.credentialMode,
          ...(config.coordinatorModel
            ? { coordinatorModel: config.coordinatorModel }
            : {}),
        });
    coordinatorLoop = new CoordinatorLoop(store, coordinator, turn);
    if (coordinator instanceof PiCoordinatorRuntime)
      coordinator.setInputHandler((text) =>
        coordinatorLoop!.submitUserMessage(text).then(() => undefined),
      );
    const recovery = new RecoveryService({
      store,
      adapters,
      completion,
      scheduler,
      git,
    });
    await recovery.recover();
    return new PhiApp(config, {
      database,
      store,
      git,
      scheduler,
      coordinatorLoop,
      outbox,
      followUps,
      coordinator,
      adapters,
    });
  }

  start(): void {
    this.outbox.start();
    this.followUps.start();
    this.coordinatorLoop.start();
    this.scheduler.start();
  }
  submitUserMessage(
    text: string,
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    return this.coordinatorLoop.submitUserMessage(text, metadata);
  }
  async runDeveloperTui(): Promise<void> {
    if (!(this.coordinator instanceof PiCoordinatorRuntime))
      throw new Error(
        "Pi developer TUI requires the Pi coordinator; omit --direct",
      );
    await this.coordinator.runDeveloperTui();
  }
  async waitUntilIdle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const jobs = this.store
        .listJobs()
        .some(
          (job) =>
            ![
              "completed",
              "failed",
              "cancelled",
              "unknown",
              "needs_input",
            ].includes(job.status),
        );
      const events = this.store
        .listEvents()
        .some((event) => event.visibleAt && !event.processedAt);
      const outbox = this.store
        .listOutbox()
        .some((message) => message.status !== "delivered");
      const servicesIdle =
        this.scheduler.isIdle() &&
        this.coordinatorLoop.isIdle() &&
        this.outbox.isIdle() &&
        this.followUps.isIdle();
      if (!jobs && !events && !outbox && servicesIdle) return;
      await Bun.sleep(10);
    }
    throw new Error(`Phi did not become idle within ${timeoutMs}ms`);
  }
  async close(): Promise<void> {
    this.scheduler.stop();
    this.followUps.stop();
    this.outbox.stop();
    this.coordinatorLoop.stop();
    await this.coordinator.close();
    this.database.close();
  }
}
