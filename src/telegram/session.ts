export interface PendingNewEmail {
  action: "newemail";
  chatId: bigint;
  chatTitle: string;
}

export interface PendingAllowRule {
  action: "allowrule";
  aliasId: string;
  aliasLocalPart: string;
}

export type PendingAction = PendingNewEmail | PendingAllowRule;

interface UserSession {
  pending?: PendingAction;
  lastTouched: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // sweep every 30 minutes

const sessions = new Map<number, UserSession>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the background sweep that removes stale sessions. */
export function startSessionSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [userId, session] of sessions) {
      if (session.lastTouched < cutoff) {
        sessions.delete(userId);
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/** Stop the sweep timer and clear all session state (used in tests/shutdown). */
export function destroySessionStore(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sessions.clear();
}

function get(userId: number): UserSession {
  return sessions.get(userId) ?? { lastTouched: Date.now() };
}

function touch(userId: number, session: UserSession): UserSession {
  return { ...session, lastTouched: Date.now() };
}

export function getPending(userId: number): PendingAction | undefined {
  return get(userId).pending;
}

export function setPending(userId: number, pending: PendingAction): void {
  sessions.set(userId, touch(userId, { ...get(userId), pending }));
}

export function clearPending(userId: number): void {
  const s = get(userId);
  if (s.pending) {
    const { pending: _, ...rest } = s;
    sessions.set(userId, touch(userId, rest));
  }
}
