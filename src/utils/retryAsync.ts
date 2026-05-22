/**
 * Runs `fn`, retrying on rejection up to `attempts` times in total, waiting the
 * configured delay between tries. Re-throws the last error if every attempt
 * fails.
 *
 * Used for the post-send persistence write: the Telegram message has already
 * been sent, so a transient DB failure must not be allowed to strand the
 * delivery record (which would make the retry worker resend — a duplicate).
 */
export interface RetryOptions {
  /** Total number of tries, including the first. Must be >= 1. */
  attempts: number;
  /** Delay before each retry; the last value is reused if there are more retries than entries. */
  delaysMs: readonly number[];
}

export async function retryAsync<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (attempt < options.attempts - 1) {
        const delay =
          options.delaysMs[attempt] ?? options.delaysMs[options.delaysMs.length - 1] ?? 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}
