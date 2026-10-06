/**
 * Bounded background queue for first-bounce notices.
 *
 * The inbound routes call `admit()` after their response is sent. `admit()`
 * is constant-time and never throws: it checks the bounds, copies the few
 * fields a job needs, and schedules the job with `setImmediate`. Everything
 * else (DB, DNS, Telegram) happens in the job, under the limits in
 * `bounds.ts`:
 *
 * - at most `maxAdmittedJobs` jobs exist at once, queued or running, counted
 *   until each job's promise settles (a deadline does not free a slot early);
 * - at most `maxConcurrentAuthentications` sender authentications run at once;
 * - at most `maxHeldMimeBytes` of raw MIME is held across all jobs; a message
 *   that does not fit is admitted without its MIME (no authentication, so no
 *   one-tap button);
 * - a job that starts later than `maxJobAgeAtStartMs` after admission is
 *   dropped, and after `jobDeadlineMs` a job starts no further phase.
 *
 * Shutdown stops admission, discards jobs that have not started, stops
 * running jobs at their next phase boundary, aborts in-flight Telegram sends
 * and waits at most `shutdownWaitMs`. These jobs are deliberately not part of
 * the delivery pipeline tracker: a notice must never hold up a delivery drain.
 */
import { NOTICE_BOUNDS, type NoticeBounds } from "./bounds.js";
import {
  recordActivationNotice,
  type ActivationNoticeResult,
  type ActivationNoticeStage,
} from "../observability/metrics.js";
import { getLogger } from "../utils/logger.js";

export interface ActivationNoticeRequest {
  stage: ActivationNoticeStage;
  aliasId: string;
  /** The single, valid header From domain of the bounced mail (raw stage only). */
  headerFromDomain: string | null;
  /** Normalized SMTP envelope sender, passed to sender authentication. */
  envelopeFrom: string | null;
  /** The raw MIME, offered so the job can authenticate the From domain. */
  rawMime: Buffer | null;
}

export interface ActivationNoticeJob {
  readonly stage: ActivationNoticeStage;
  readonly aliasId: string;
  readonly headerFromDomain: string | null;
  readonly envelopeFrom: string | null;
  /** Held MIME; null when none was offered, none is needed, or it did not fit. */
  readonly mime: Buffer | null;
  readonly admittedAt: number;
}

/** Thrown by `beginPhase()` once the job may not start another phase. */
export class NoticePhaseStopped extends Error {
  constructor(readonly reason: "shutdown" | "deadline") {
    super(`activation notice stopped: ${reason}`);
    this.name = "NoticePhaseStopped";
  }
}

export type AuthenticationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "budget" | "stopped" | "error" };

export interface NoticeJobContext {
  /** Call before every phase; throws NoticePhaseStopped after shutdown or the deadline. */
  beginPhase(): void;
  /**
   * Runs `work` holding an authentication slot, within the authentication
   * budget (and the job deadline). The slot stays taken until `work` settles,
   * even when the job stopped waiting for it.
   */
  authenticate<T>(work: () => Promise<T>): Promise<AuthenticationOutcome<T>>;
  /** Runs a Telegram send with a signal that fires on shutdown or the send timeout. */
  withSendSignal<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export type NoticeRunner = (
  job: ActivationNoticeJob,
  ctx: NoticeJobContext,
) => Promise<ActivationNoticeResult>;

/** FIFO counting semaphore whose waits can be abandoned through a signal. */
class Slots {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get running(): number {
    return this.active;
  }

  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve(true);
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(grant);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

class JobContext implements NoticeJobContext {
  private readonly deadlineAt: number;
  private pendingAuthentication: Promise<unknown> | null = null;

  constructor(
    private readonly bounds: NoticeBounds,
    private readonly now: () => number,
    private readonly shutdownSignal: AbortSignal,
    private readonly authSlots: Slots,
  ) {
    this.deadlineAt = now() + bounds.jobDeadlineMs;
  }

  beginPhase(): void {
    if (this.shutdownSignal.aborted) throw new NoticePhaseStopped("shutdown");
    if (this.now() >= this.deadlineAt) throw new NoticePhaseStopped("deadline");
  }

  async authenticate<T>(work: () => Promise<T>): Promise<AuthenticationOutcome<T>> {
    this.beginPhase();
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    this.shutdownSignal.addEventListener("abort", stop, { once: true });
    const budgetMs = Math.min(this.bounds.authenticationBudgetMs, this.deadlineAt - this.now());
    const timer = setTimeout(stop, Math.max(0, budgetMs));
    try {
      if (!(await this.authSlots.acquire(controller.signal))) {
        return { ok: false, reason: this.shutdownSignal.aborted ? "stopped" : "budget" };
      }
      const running = (async () => {
        try {
          return await work();
        } finally {
          this.authSlots.release();
        }
      })();
      this.pendingAuthentication = running.catch(() => undefined);
      return await new Promise<AuthenticationOutcome<T>>((resolve) => {
        const onStop = (): void =>
          resolve({ ok: false, reason: this.shutdownSignal.aborted ? "stopped" : "budget" });
        if (controller.signal.aborted) onStop();
        controller.signal.addEventListener("abort", onStop, { once: true });
        running.then(
          (value) => {
            controller.signal.removeEventListener("abort", onStop);
            resolve({ ok: true, value });
          },
          () => {
            controller.signal.removeEventListener("abort", onStop);
            resolve({ ok: false, reason: "error" });
          },
        );
      });
    } finally {
      clearTimeout(timer);
      this.shutdownSignal.removeEventListener("abort", stop);
    }
  }

  async withSendSignal<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (this.shutdownSignal.aborted) abort();
    else this.shutdownSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.bounds.telegramSendTimeoutMs);
    try {
      return await send(controller.signal);
    } finally {
      clearTimeout(timer);
      this.shutdownSignal.removeEventListener("abort", abort);
    }
  }

  /** Resolves once an authentication the job stopped waiting for has settled. */
  async settle(): Promise<void> {
    await this.pendingAuthentication;
  }
}

export class ActivationNoticeQueue {
  private closed = false;
  private readonly shutdownController = new AbortController();
  private admittedJobs = 0;
  private heldMime = 0;
  private readonly unsettled = new Set<Promise<void>>();
  private readonly authSlots: Slots;

  constructor(
    private readonly runner: NoticeRunner,
    private readonly bounds: NoticeBounds = NOTICE_BOUNDS,
    private readonly now: () => number = Date.now,
  ) {
    this.authSlots = new Slots(bounds.maxConcurrentAuthentications);
  }

  /** Jobs admitted and not yet settled. */
  get admitted(): number {
    return this.admittedJobs;
  }

  get heldMimeBytes(): number {
    return this.heldMime;
  }

  get runningAuthentications(): number {
    return this.authSlots.running;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Constant-time and non-throwing. Returns whether the job was admitted; a
   * refused job is counted as `dropped`.
   */
  admit(request: ActivationNoticeRequest): boolean {
    try {
      if (this.closed || this.admittedJobs >= this.bounds.maxAdmittedJobs) {
        recordActivationNotice(request.stage, "dropped");
        return false;
      }
      // MIME is only worth holding when there is a From domain to authenticate.
      const offered = request.headerFromDomain ? request.rawMime : null;
      const mime =
        offered &&
        offered.length > 0 &&
        this.heldMime + offered.length <= this.bounds.maxHeldMimeBytes
          ? offered
          : null;
      const job: ActivationNoticeJob = {
        stage: request.stage,
        aliasId: request.aliasId,
        headerFromDomain: request.headerFromDomain,
        envelopeFrom: request.envelopeFrom,
        mime,
        admittedAt: this.now(),
      };
      const mimeBytes = mime?.length ?? 0;
      this.admittedJobs += 1;
      this.heldMime += mimeBytes;
      const settled: Promise<void> = this.run(job)
        .catch(() => undefined)
        .finally(() => {
          this.admittedJobs -= 1;
          this.heldMime -= mimeBytes;
          this.unsettled.delete(settled);
        });
      this.unsettled.add(settled);
      return true;
    } catch {
      return false;
    }
  }

  /** Resolves once every job admitted so far has settled. */
  async whenIdle(): Promise<void> {
    while (this.unsettled.size > 0) {
      await Promise.allSettled([...this.unsettled]);
    }
  }

  /**
   * Stops admission, discards jobs that have not started, stops running jobs
   * at their next phase, aborts in-flight sends, and waits at most
   * `shutdownWaitMs` for running jobs to settle.
   */
  async shutdown(waitMs: number = this.bounds.shutdownWaitMs): Promise<void> {
    this.closed = true;
    this.shutdownController.abort();
    if (this.unsettled.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.unsettled]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private async run(job: ActivationNoticeJob): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ctx = new JobContext(
      this.bounds,
      this.now,
      this.shutdownController.signal,
      this.authSlots,
    );
    let result: ActivationNoticeResult;
    try {
      if (this.closed || this.now() - job.admittedAt > this.bounds.maxJobAgeAtStartMs) {
        result = "dropped";
      } else {
        result = await this.runner(job, ctx);
      }
    } catch (err: unknown) {
      if (err instanceof NoticePhaseStopped) {
        result = "dropped";
      } else {
        result = "failed";
        getLogger().warn({ err, aliasId: job.aliasId }, "activation.notice.failed");
      }
    } finally {
      await ctx.settle();
    }
    recordActivationNotice(job.stage, result);
  }
}
