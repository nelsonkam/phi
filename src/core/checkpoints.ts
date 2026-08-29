import {
  GitWorkspace,
  GIT_DRAIN_MS,
  GIT_TERM_GRACE_MS,
  type CheckpointTrigger,
} from "@/core/git";
import {
  GIT_REMOTE_COMMAND_TIMEOUT_MS,
  GIT_REMOTE_FLUSH_TIMEOUT_MS,
  classifyRemoteError,
  readGitRemoteConfig,
  type GitRemoteConfig,
} from "@/core/git-remote";
import type { PhiStore } from "@/core/store/store";
import type {
  CheckpointHealth,
  GitCheckpoint,
  RemoteHealth,
  RestoreScope,
} from "@/shared/types";

export class CheckpointBusyError extends Error {
  readonly status = 409;
  constructor() {
    super("workspace is busy");
  }
}

export class CheckpointHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function newCheckpointId(): string {
  return `cp_${crypto.randomUUID().replaceAll("-", "")}`;
}

export class CheckpointService {
  private readonly store: PhiStore;
  private readonly git: GitWorkspace;
  private readonly remoteConfig: GitRemoteConfig;
  private chain: Promise<unknown> = Promise.resolve();
  private healthState: CheckpointHealth = {
    status: "ok",
    error: null,
    lastSha: null,
  };
  private remoteState: RemoteHealth;
  private closed = false;
  private phiOwned = false;
  private desiredSha: string | null = null;
  private scheduleGen = 0;
  private remoteInFlight = false;
  private remoteIdleWaiters: Array<() => void> = [];
  private remoteAbort = new AbortController();
  private flushDeadline: number | null = null;

  constructor(store: PhiStore, workspaceRoot: string) {
    this.store = store;
    this.git = new GitWorkspace(workspaceRoot);
    this.remoteConfig = readGitRemoteConfig(store.rootPath);
    this.remoteState = initialRemoteHealth(this.remoteConfig);
  }

  health(): CheckpointHealth {
    return { ...this.healthState };
  }

  remoteHealth(): RemoteHealth {
    return { ...this.remoteState };
  }

  async initialize(): Promise<void> {
    await this.run(async () => {
      try {
        await this.initializeInner();
      } catch (error) {
        this.degrade(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private async initializeInner(): Promise<void> {
    const workspace = this.store.defaultWorkspace();
    const inspect = await this.git.inspect();
    if (inspect.kind === "hostile" || inspect.kind === "ancestor") {
      this.degrade(inspect.reason ?? inspect.kind);
      return;
    }
    if (inspect.kind === "missing") {
      await this.git.init();
      this.phiOwned = true;
      await this.captureAndRecord("baseline");
      return;
    }
    if (inspect.kind === "unborn") {
      if (!inspect.indexMatchesHead) {
        this.degrade("unborn HEAD with a dirty index");
        return;
      }
      this.phiOwned = true;
      await this.captureAndRecord("baseline");
      return;
    }

    await this.recoverTrailers(workspace.id, inspect.head);
    if (inspect.kind === "foreign") {
      this.degrade(inspect.reason ?? "foreign git repository");
      return;
    }

    const latest = this.store.latestCheckpoint(workspace.id);
    if (latest && inspect.head && !(await this.git.isAncestor(latest.commitSha, inspect.head))) {
      this.degrade("recorded checkpoint is not an ancestor of HEAD");
      return;
    }

    if (!inspect.indexMatchesHead) {
      await this.git.normalizeIndexToHead();
    }
    this.phiOwned = true;
    if (await this.git.isDirty()) {
      await this.captureAndRecord("startup");
    } else {
      const head = await this.git.head();
      if (head) this.ok(head);
      if (head) this.schedulePush(head);
    }
  }

  async checkpoint(input: {
    trigger: CheckpointTrigger;
    threadId?: string | null;
  }): Promise<GitCheckpoint | null> {
    return this.run(async () => {
      if (this.closed) return null;
      try {
        if (!(await this.validateMutableState())) return null;
        return await this.captureAndRecord(input.trigger, input.threadId);
      } catch (error) {
        this.degrade(error instanceof Error ? error.message : String(error));
        return null;
      }
    });
  }

  async restore(input: {
    checkpointId: string;
    scope: RestoreScope;
    confirm?: boolean;
  }): Promise<{ checkpoint: GitCheckpoint | null; noop: boolean }> {
    if (input.scope === "all" && !input.confirm) {
      throw new CheckpointHttpError(400, "confirm is required for all restore");
    }
    return this.run(async () => {
      if (this.closed) throw new CheckpointHttpError(503, "checkpoint service closed");
      try {
        if (!(await this.validateMutableState())) {
          throw new CheckpointHttpError(
            503,
            this.healthState.error ?? "degraded",
          );
        }
        const target = this.store.checkpointById(input.checkpointId);
        if (!target) throw new CheckpointHttpError(404, "checkpoint not found");
        if (await this.git.isDirty()) {
          await this.captureAndRecord("manual");
          if (this.healthState.status === "degraded") {
            throw new CheckpointHttpError(
              503,
              this.healthState.error ?? "degraded",
            );
          }
        }
        const restoreId = newCheckpointId();
        const sha = await this.git.restoreScope({
          sourceSha: target.commitSha,
          scope: input.scope,
          checkpointId: restoreId,
        });
        if (!sha) {
          this.store.reconcileChannelFolders();
          return {
            checkpoint: this.store.latestCheckpoint(this.workspaceId()),
            noop: true,
          };
        }
        const row = this.recordCheckpoint({
          id: restoreId,
          commitSha: sha,
          trigger: "manual",
        });
        if (!row) {
          throw new CheckpointHttpError(
            503,
            this.healthState.error ?? "degraded",
          );
        }
        this.store.reconcileChannelFolders();
        return { checkpoint: row, noop: false };
      } catch (error) {
        if (error instanceof CheckpointHttpError) throw error;
        this.degrade(error instanceof Error ? error.message : String(error));
        throw new CheckpointHttpError(
          503,
          this.healthState.error ?? "degraded",
        );
      }
    });
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  async flushRemote(
    timeoutMs: number = GIT_REMOTE_FLUSH_TIMEOUT_MS,
  ): Promise<void> {
    if (this.remoteConfig.kind !== "ok") return;
    this.flushDeadline = Date.now() + timeoutMs;
    const abort = this.remoteAbort;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      if (!this.remoteInFlight && this.desiredSha) {
        this.remoteInFlight = true;
        void this.runRemoteLoop();
      }
      await this.waitRemoteIdle(timeoutMs + GIT_TERM_GRACE_MS + GIT_DRAIN_MS);
      if (this.remoteInFlight) {
        abort.abort();
        await this.waitRemoteIdle(GIT_TERM_GRACE_MS + GIT_DRAIN_MS);
      }
    } finally {
      clearTimeout(timer);
      this.flushDeadline = null;
      if (abort.signal.aborted) this.remoteAbort = new AbortController();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    await this.flushRemote();
  }

  list(): GitCheckpoint[] {
    return this.store.listCheckpoints(this.workspaceId());
  }

  private workspaceId(): string {
    return this.store.defaultWorkspace().id;
  }

  private async validateMutableState(): Promise<boolean> {
    const inspect = await this.git.inspect({ assumeOwned: this.phiOwned });
    if (
      inspect.kind === "hostile" ||
      inspect.kind === "ancestor" ||
      inspect.kind === "foreign" ||
      inspect.kind === "missing" ||
      inspect.kind === "unborn"
    ) {
      this.degrade(inspect.reason ?? inspect.kind);
      this.phiOwned = false;
      return false;
    }
    const head = inspect.head;
    if (!head) {
      this.degrade("missing HEAD");
      return false;
    }
    await this.recoverTrailers(this.workspaceId(), head);
    const latest = this.store.latestCheckpoint(this.workspaceId());
    if (latest && !(await this.git.isAncestor(latest.commitSha, head))) {
      this.degrade("recorded checkpoint is not an ancestor of HEAD");
      this.phiOwned = false;
      return false;
    }
    this.phiOwned = true;
    return true;
  }

  private async recoverTrailers(
    workspaceId: string,
    head: string | null,
  ): Promise<number> {
    if (!head) return 0;
    const latest = this.store.latestCheckpoint(workspaceId);
    if (latest && !(await this.git.isAncestor(latest.commitSha, head))) {
      return 0;
    }
    const trailers = await this.git.logPhiTrailers(latest?.commitSha ?? null);
    let inserted = 0;
    for (const trailer of trailers) {
      const before = this.store.checkpointBySha(trailer.sha);
      this.store.insertCheckpoint({
        id: trailer.checkpointId,
        workspaceId,
        commitSha: trailer.sha,
        trigger: trailer.trigger,
        triggerThreadId: trailer.triggerThreadId,
      });
      if (!before) inserted += 1;
    }
    return inserted;
  }

  private async captureAndRecord(
    trigger: CheckpointTrigger,
    threadId?: string | null,
  ): Promise<GitCheckpoint | null> {
    const id = newCheckpointId();
    const sha = await this.git.capture({
      checkpointId: id,
      trigger,
      triggerThreadId: threadId,
    });
    if (!sha) {
      const head = await this.git.head();
      const latest = this.store.latestCheckpoint(this.workspaceId());
      if (head && latest?.commitSha === head) {
        this.ok(head);
        this.schedulePush(head);
      }
      return null;
    }
    return this.recordCheckpoint({
      id,
      commitSha: sha,
      trigger,
      triggerThreadId: threadId,
    });
  }

  private recordCheckpoint(input: {
    id: string;
    commitSha: string;
    trigger: CheckpointTrigger;
    triggerThreadId?: string | null;
  }): GitCheckpoint | null {
    try {
      const row = this.store.insertCheckpoint({
        id: input.id,
        workspaceId: this.workspaceId(),
        commitSha: input.commitSha,
        trigger: input.trigger,
        triggerThreadId: input.triggerThreadId,
      });
      this.ok(input.commitSha);
      this.schedulePush(input.commitSha);
      return row;
    } catch (error) {
      this.degrade(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private degrade(error: string): void {
    this.healthState = {
      status: "degraded",
      error,
      lastSha: this.healthState.lastSha,
    };
  }

  private ok(sha: string): void {
    this.healthState = { status: "ok", error: null, lastSha: sha };
  }

  private schedulePush(sha: string): void {
    if (this.closed) return;
    if (this.remoteConfig.kind !== "ok") return;
    if (!this.phiOwned) return;
    if (this.healthState.status === "degraded") return;
    if (
      this.remoteState.status === "ok" &&
      this.remoteState.lastPushedSha === sha
    ) {
      return;
    }
    this.desiredSha = sha;
    this.scheduleGen += 1;
    this.markRemotePending();
    if (!this.remoteInFlight) {
      this.remoteInFlight = true;
      void this.runRemoteLoop();
    }
  }

  private markRemotePending(): void {
    if (
      this.remoteState.status === "ok" ||
      this.remoteState.status === "degraded"
    ) {
      return;
    }
    this.remoteState = {
      status: "pending",
      configured: true,
      displayUrl:
        this.remoteConfig.kind === "ok" ? this.remoteConfig.displayUrl : null,
      lastPushedSha: this.remoteState.lastPushedSha,
      error: null,
    };
  }

  private remainingTimeout(): number {
    if (this.flushDeadline !== null) {
      return Math.max(0, this.flushDeadline - Date.now());
    }
    return GIT_REMOTE_COMMAND_TIMEOUT_MS;
  }

  private async runRemoteLoop(): Promise<void> {
    this.remoteInFlight = true;
    let attemptGen = this.scheduleGen;
    const url = this.remoteConfig.kind === "ok" ? this.remoteConfig.url : null;
    if (!url) {
      this.remoteInFlight = false;
      this.resolveRemoteIdle();
      return;
    }
    this.markRemotePending();
    try {
      while (true) {
        const sha = this.desiredSha;
        attemptGen = this.scheduleGen;
        if (!sha) break;
        const timeoutMs = this.remainingTimeout();
        const signal = this.remoteAbort.signal;
        await this.git.ensureOrigin(url, { timeoutMs, signal });
        await this.git.pushSha(sha, { timeoutMs, signal });
        if (this.scheduleGen !== attemptGen) continue;
        this.desiredSha = null;
        this.remoteState = {
          status: "ok",
          configured: true,
          displayUrl: this.remoteConfig.kind === "ok"
            ? this.remoteConfig.displayUrl
            : null,
          lastPushedSha: sha,
          error: null,
        };
        break;
      }
    } catch (error) {
      this.remoteState = {
        status: "degraded",
        configured: true,
        displayUrl:
          this.remoteConfig.kind === "ok" ? this.remoteConfig.displayUrl : null,
        lastPushedSha: this.remoteState.lastPushedSha,
        error: this.remoteError(error),
      };
    } finally {
      if (
        this.scheduleGen !== attemptGen &&
        this.desiredSha
      ) {
        void this.runRemoteLoop();
      } else {
        this.remoteInFlight = false;
        this.resolveRemoteIdle();
      }
    }
  }

  private remoteError(error: unknown): string {
    return classifyRemoteError(error);
  }

  private waitRemoteIdle(maxMs: number): Promise<void> {
    if (!this.remoteInFlight) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, maxMs);
      this.remoteIdleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private resolveRemoteIdle(): void {
    const waiters = this.remoteIdleWaiters;
    this.remoteIdleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function initialRemoteHealth(config: GitRemoteConfig): RemoteHealth {
  if (config.kind === "unset") {
    return {
      status: "unset",
      configured: false,
      displayUrl: null,
      lastPushedSha: null,
      error: null,
    };
  }
  if (config.kind === "invalid") {
    return {
      status: "degraded",
      configured: false,
      displayUrl: null,
      lastPushedSha: null,
      error: config.error,
    };
  }
  return {
    status: "pending",
    configured: true,
    displayUrl: config.displayUrl,
    lastPushedSha: null,
    error: null,
  };
}
