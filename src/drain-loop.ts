export class DrainLoop {
  private stopped = false;
  private draining = false;
  private wakePending = false;

  constructor(
    private readonly drainOnce: () => Promise<boolean>,
    private readonly onError?: (error: unknown) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.wake();
  }

  stop(): void {
    this.stopped = true;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  isIdle(): boolean {
    return !this.draining && !this.wakePending;
  }

  wake(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.wakePending = true;
      return;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.stopped && (await this.drainOnce())) {}
    } catch (error) {
      if (!this.onError) throw error;
      this.onError(error);
    } finally {
      this.draining = false;
      if (this.wakePending) {
        this.wakePending = false;
        this.wake();
      }
    }
  }
}
