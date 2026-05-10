import { describe, expect, it } from "vitest";
import { escapeHtml, escapeHtmlAttribute } from "../../../src/utils/html.js";

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes less-than and greater-than", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("leaves safe text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("escapes multiple special chars", () => {
    expect(escapeHtml("<a & b>")).toBe("&lt;a &amp; b&gt;");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });
});

describe("escapeHtmlAttribute", () => {
  it("escapes double quotes", () => {
    expect(escapeHtmlAttribute('say "hi"')).toBe("say &quot;hi&quot;");
  });

  it("also escapes html chars", () => {
    expect(escapeHtmlAttribute('<a href="x&y">')).toBe("&lt;a href=&quot;x&amp;y&quot;&gt;");
  });

  it("leaves safe text unchanged", () => {
    expect(escapeHtmlAttribute("safe")).toBe("safe");
  });
});
