export function normalizeEnvelopeSender(value: string | null | undefined): string | null {
  const sender = value?.trim();
  return sender ? sender : null;
}
