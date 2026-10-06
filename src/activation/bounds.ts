/**
 * Every bound on the first-bounce notice path, in one place.
 *
 * The notice runs after the inbound response is already on the wire, but it
 * still shares the event loop, the DB pool and Telegram's rate limits with
 * delivery. These limits keep that share small.
 */
import { SIDE_WORK_TIMEOUTS } from "../db/boundedTransaction.js";

export interface NoticeBounds {
  /** Jobs admitted at once, queued plus running, counted until each settles. */
  maxAdmittedJobs: number;
  /** Sender authentications (DKIM/DMARC DNS work) running at once. */
  maxConcurrentAuthentications: number;
  /** Raw MIME bytes held across all admitted jobs; a larger message is admitted without it. */
  maxHeldMimeBytes: number;
  /** A job that has not started this long after admission is dropped. */
  maxJobAgeAtStartMs: number;
  /** After this long a job starts no further phase. */
  jobDeadlineMs: number;
  /**
   * Waiting for an authentication slot plus running it. Past this the notice
   * goes out without the one-tap button; the authentication keeps its slot
   * (and the job its MIME) until it settles.
   */
  authenticationBudgetMs: number;
  /** `SET LOCAL statement_timeout` for every notice and button transaction. */
  statementTimeout: string;
  /** `SET LOCAL lock_timeout` for every notice and button transaction. */
  lockTimeout: string;
  /** AbortSignal timeout on the Telegram send. */
  telegramSendTimeoutMs: number;
  /** How long shutdown waits for running jobs. */
  shutdownWaitMs: number;
  /** Fresh admin check before the one-tap button mutates anything. */
  buttonAccessCheckTimeoutMs: number;
}

export const NOTICE_BOUNDS: Readonly<NoticeBounds> = Object.freeze({
  maxAdmittedJobs: 8,
  maxConcurrentAuthentications: 2,
  maxHeldMimeBytes: 4 * 1024 * 1024,
  maxJobAgeAtStartMs: 60_000,
  jobDeadlineMs: 20_000,
  authenticationBudgetMs: 8_000,
  // 5 s statements, 2 s lock waits: the same bounds as the marker write.
  statementTimeout: SIDE_WORK_TIMEOUTS.statementTimeout,
  lockTimeout: SIDE_WORK_TIMEOUTS.lockTimeout,
  telegramSendTimeoutMs: 10_000,
  shutdownWaitMs: 2_000,
  buttonAccessCheckTimeoutMs: 5_000,
});
