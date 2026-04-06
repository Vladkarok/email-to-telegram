export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly store = new Map<string, number[]>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.store.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= this.max) {
      this.store.set(key, timestamps);
      return false;
    }

    timestamps.push(now);
    this.store.set(key, timestamps);
    return true;
  }

  /** Start a background sweep that removes fully-expired keys every `intervalMs`. */
  startSweep(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const cutoff = Date.now() - this.windowMs;
      for (const [key, timestamps] of this.store) {
        if (timestamps.every((t) => t <= cutoff)) {
          this.store.delete(key);
        }
      }
    }, intervalMs);
    // Allow Node.js to exit even if the sweep is still scheduled
    this.sweepTimer.unref?.();
  }

  /** Stop the sweep timer and clear all stored state. */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.store.clear();
  }
}
