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
import { CompletionService } from "./jobs/completion.ts";
import { FollowUpDispatcher } from "./jobs/followups.ts";
import { RecoveryService } from "./jobs/recovery.ts";
import { JobScheduler } from "./jobs/scheduler.ts";
import { activeJobStatuses, type MessageRecord } from "./domain.ts";
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
    readonly followUps: FollowUpDispatcher,
    private readonly coordinator: CoordinatorRuntime,
  ) {
    this.coordinatorTraces = coordinator.traces;
  }

  static async create(
    config: PhiConfig,
    options: {
      directCoordinator?: boolean;
      onMessage?: (message: MessageRecord) => void;
    } = {},
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
    const adapters = buildAdapterRegistry(config);
    const followUps = new FollowUpDispatcher(store, adapters);
    let coordinatorLoop: CoordinatorLoop | null = null;
    const completion = new CompletionService(store, git, () =>
      coordinatorLoop?.wake(),
    );
    const scheduler = new JobScheduler({
      store,
      adapters,
      completion,
      workspace: config.paths.workspace,
      concurrency: config.concurrency,
    });
    const turn = new TurnContext();
    const tools = new CoordinatorTools({
      store,
      workspace: config.paths.workspace,
      turn,
      scheduler,
      followUps,
      adapters,
      ...(options.onMessage ? { onMessage: options.onMessage } : {}),
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
      followUps,
      coordinator,
    );
  }

  start(): void {
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
        .some((job) => activeJobStatuses.has(job.status));
      const events = this.store
        .listEvents()
        .some((event) => event.visibleAt && !event.processedAt);
      const servicesIdle =
        this.scheduler.isIdle() &&
        this.coordinatorLoop.isIdle() &&
        this.followUps.isIdle();
      if (!jobs && !events && servicesIdle) return;
      await Bun.sleep(10);
    }
    throw new Error(`Phi did not become idle within ${timeoutMs}ms`);
  }
  async close(): Promise<void> {
    this.scheduler.stop();
    this.followUps.stop();
    this.coordinatorLoop.stop();
    await this.coordinator.close();
    this.database.close();
  }
}
