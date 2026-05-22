/**
 * Cleans an email body by removing signatures and quoted reply text.
 */
export function cleanEmailBody(text: string): string {
  if (!text) return text;

  // Strip RFC 3676 signature delimiter (-- \n) and (--\n), removing everything after
  text = text.replace(/\n--[ ]?\r?\n[\s\S]*$/, "");

  // Strip an "On ... wrote:" attribution block and everything after it (quoted reply).
  // "wrote:" must sit at end-of-line: real mail-client attributions put the quoted
  // text on the next line, whereas a benign mid-body sentence ("On Monday Sarah
  // wrote: see attached") has inline text after the colon and must be preserved.
  // The {0,200} bound keeps the attribution span realistic and prevents
  // pathological backtracking on adversarial input.
  text = text.replace(/\nOn [\s\S]{0,200}?wrote:[ \t]*\r?\n[\s\S]*/, "");

  // Strip remaining quoted reply lines starting with >
  const lines = text.split("\n");
  text = lines.filter((line) => !line.startsWith(">")).join("\n");

  return text.trim();
}
