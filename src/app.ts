import type { PhiConfig } from "./config.ts";
import { CoordinatorLoop } from "./coordinator/loop.ts";
import {
  DirectCoordinatorRuntime,
  PiCoordinatorRuntime,
  type CoordinatorRuntime,
} from "./coordinator/runtime.ts";
import { CoordinatorTools } from "./coordinator/tools.ts";
import type { CoordinatorTraceStore } from "./coordinator/trace.ts";
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
import type { WorkerAdapterRegistry } from "./workers/adapter.ts";
import { buildAdapterRegistry } from "./workers/registry.ts";

export class PhiApp {
  readonly coordinatorTraces: CoordinatorTraceStore;

  private constructor(
    readonly config: PhiConfig,
    readonly database: PhiDatabase,
    readonly store: PhiStore,
    readonly adapters: WorkerAdapterRegistry,
    readonly git: GitService,
    readonly scheduler: JobScheduler,
    readonly coordinatorLoop: CoordinatorLoop,
    readonly outbox: OutboxDispatcher,
    readonly followUps: FollowUpDispatcher,
    private readonly coordinator: CoordinatorRuntime,
  ) {
    this.coordinatorTraces = coordinator.traces;
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
    const adapters = buildAdapterRegistry(config);
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
      adapters,
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
    const recovery = new RecoveryService({
      store,
      adapters,
      completion,
      scheduler,
      git,
    });
    await recovery.recover();
    return new PhiApp(
      config,
      database,
      store,
      adapters,
      git,
      scheduler,
      coordinatorLoop,
      outbox,
      followUps,
      coordinator,
    );
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
    const { runPhiTui } = await import("./ui/tui.tsx");
    await runPhiTui(this);
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
