import { vi } from "vitest";

/**
 * A chainable Drizzle-like mock. Each method returns `this` so builder
 * chains like `.insert().values().onConflictDoUpdate().returning()` resolve
 * to the configured terminal value.
 */
export class ChainableMock {
  private _resolveValue: unknown = [];

  /** Set what the final awaited call should resolve to. */
  resolves(value: unknown) {
    this._resolveValue = value;
    return this;
  }

  // Every Drizzle builder method — add more as needed
  insert = vi.fn().mockReturnThis();
  update = vi.fn().mockReturnThis();
  delete = vi.fn().mockReturnThis();
  select = vi.fn().mockReturnThis();
  values = vi.fn().mockReturnThis();
  set = vi.fn().mockReturnThis();
  onConflictDoUpdate = vi.fn().mockReturnThis();
  returning = vi.fn(() => Promise.resolve(this._resolveValue));
  from = vi.fn().mockReturnThis();
  where = vi.fn(() => Promise.resolve(this._resolveValue));
  innerJoin = vi.fn().mockReturnThis();
  leftJoin = vi.fn().mockReturnThis();
  orderBy = vi.fn().mockReturnThis();
  limit = vi.fn(() => Promise.resolve(this._resolveValue));
  execute = vi.fn(() => Promise.resolve(this._resolveValue));

  /** Reset all mock state. */
  reset() {
    this._resolveValue = [];
    for (const key of Object.keys(this)) {
      const val = (this as Record<string, unknown>)[key];
      if (val && typeof val === "function" && "mockReset" in val) {
        (val as ReturnType<typeof vi.fn>).mockReset();
        (val as ReturnType<typeof vi.fn>).mockReturnThis();
      }
    }
    this.returning = vi.fn(() => Promise.resolve(this._resolveValue));
    this.where = vi.fn(() => Promise.resolve(this._resolveValue));
    this.limit = vi.fn(() => Promise.resolve(this._resolveValue));
    this.execute = vi.fn(() => Promise.resolve(this._resolveValue));
  }
}
