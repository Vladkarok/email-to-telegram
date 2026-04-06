/**
 * Tracks a count of in-flight async operations so that a graceful-shutdown
 * sequence can wait for them to complete before tearing down shared resources
 * (DB pool, Telegram API connection, etc.).
 */
export class InFlightTracker {
  private count = 0;
  private readonly waiters: Array<() => void> = [];

  /** Increment the counter, run fn, decrement, then notify any drain waiters. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.count++;
    try {
      return await fn();
    } finally {
      this.count--;
      if (this.count === 0) {
        for (const resolve of this.waiters.splice(0)) {
          resolve();
        }
      }
    }
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
}

/** Module-level singleton used by the inbound pipeline. */
export const pipelineTracker = new InFlightTracker();
