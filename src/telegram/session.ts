export interface PendingNewEmail {
  action: "newemail";
  chatId: bigint;
  chatTitle: string;
}

interface UserSession {
  pending?: PendingNewEmail;
}

const sessions = new Map<number, UserSession>();

function get(userId: number): UserSession {
  return sessions.get(userId) ?? {};
}

export function getPending(userId: number): PendingNewEmail | undefined {
  return get(userId).pending;
}

export function setPending(userId: number, pending: PendingNewEmail): void {
  sessions.set(userId, { ...get(userId), pending });
}

export function clearPending(userId: number): void {
  const s = get(userId);
  if (s.pending) {
    const { pending: _, ...rest } = s;
    sessions.set(userId, rest);
  }
}
