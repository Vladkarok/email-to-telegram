/**
 * Tracks a count of in-flight async operations so that a graceful-shutdown
 * sequence can wait for them to complete before tearing down shared resources
 * (DB pool, Telegram API connection, etc.).
 */
export class InFlightTracker {
  private count = 0;
  private readonly activeKeys = new Map<string, number>();
  private readonly waiters: Array<() => void> = [];

  /** Increment the counter, run fn, decrement, then notify any drain waiters. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return this.runInternal(undefined, fn);
  }

  /** Track a specific logical unit of work, e.g. a delivery-log id. */
  async runFor<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.runInternal(key, fn);
  }

  /**
   * Resolves when the in-flight count reaches zero, or rejects after
   * `timeoutMs` if operations are still running.
   */
  drain(timeoutMs = 10_000): Promise<void> {
    if (this.count === 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(done);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `drain timed out after ${timeoutMs} ms (${this.count} operations still in flight)`,
          ),
        );
      }, timeoutMs);

      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  get inFlight(): number {
    return this.count;
  }

  isActive(key: string): boolean {
    return (this.activeKeys.get(key) ?? 0) > 0;
  }

  private async runInternal<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
    this.count++;
    if (key) {
      this.activeKeys.set(key, (this.activeKeys.get(key) ?? 0) + 1);
    }

    try {
      return await fn();
    } finally {
      this.count--;
      if (key) {
        const remaining = (this.activeKeys.get(key) ?? 1) - 1;
        if (remaining > 0) {
          this.activeKeys.set(key, remaining);
        } else {
          this.activeKeys.delete(key);
        }
      }
      if (this.count === 0) {
        for (const resolve of this.waiters.splice(0)) {
          resolve();
        }
      }
    }
  }
}

/** Module-level singleton used by the inbound pipeline. */
export const pipelineTracker = new InFlightTracker();
