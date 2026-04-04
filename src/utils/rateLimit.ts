export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly store = new Map<string, number[]>();

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
}
