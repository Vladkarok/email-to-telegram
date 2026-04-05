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
}

const sessions = new Map<number, UserSession>();

function get(userId: number): UserSession {
  return sessions.get(userId) ?? {};
}

export function getPending(userId: number): PendingAction | undefined {
  return get(userId).pending;
}

export function setPending(userId: number, pending: PendingAction): void {
  sessions.set(userId, { ...get(userId), pending });
}

export function clearPending(userId: number): void {
  const s = get(userId);
  if (s.pending) {
    const { pending: _, ...rest } = s;
    sessions.set(userId, rest);
  }
}
