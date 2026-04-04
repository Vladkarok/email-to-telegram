/**
 * Cleans an email body by removing signatures and quoted reply text.
 */
export function cleanEmailBody(text: string): string {
  if (!text) return text;

  // Strip RFC 3676 signature delimiter (-- \n) and (--\n), removing everything after
  text = text.replace(/\n--[ ]?\r?\n[\s\S]*$/, "");

  // Strip "On ... wrote:" attribution line and everything after it (including quoted lines)
  text = text.replace(/\nOn [\s\S]*?wrote:\s*[\s\S]*$/m, "");

  // Strip remaining quoted reply lines starting with >
  const lines = text.split("\n");
  text = lines.filter((line) => !line.startsWith(">")).join("\n");

  return text.trim();
}
