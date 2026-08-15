import { describe, expect, it } from "vitest";
import { renderStructuredEmailHtml } from "../../../src/utils/structuredEmailHtml.js";

describe("renderStructuredEmailHtml", () => {
  it("flattens layout tables but preserves nested semantic tables", () => {
    const result = renderStructuredEmailHtml(`
      <table role="presentation"><tr><td>
        <h2>Backup status</h2>
        <table>
          <tr><th>Name</th><th>Status</th></tr>
          <tr><td>Primary catalog</td><td>Success</td></tr>
        </table>
      </td></tr></table>
    `);

    expect(result.classicHtml).toContain("<b>Backup status</b>");
    expect(result.classicHtml).not.toContain("<pre>");
    expect(result.richHtml?.match(/<table>/g)).toHaveLength(1);
    expect(result.richHtml).toContain("<th>Name</th>");
  });

  it("turns alternating label/value cells into labeled classic lines", () => {
    const result = renderStructuredEmailHtml(`
      <table>
        <tr><td><b>Start time</b></td><td>10:00:18</td><td>Size</td><td>5,2 MB</td></tr>
        <tr><td><b>End time</b></td><td>10:01:12</td><td>Ratio</td><td>14,66x</td></tr>
      </table>
    `);

    expect(result.classicHtml).toContain("<b>Start time:</b> 10:00:18");
    expect(result.classicHtml).toContain("<b>Size:</b> 5,2 MB");
    expect(result.classicHtml).not.toContain("<pre>");
    expect(result.richHtml).toContain("<th><b>Start time</b></th>");
  });

  it("preserves validated table spans and alignment", () => {
    const result = renderStructuredEmailHtml(`
      <table>
        <tr><th colspan="2" align="center">Summary</th></tr>
        <tr><td rowspan="2" valign="top">Catalog</td><td>One</td></tr>
        <tr><td>Two</td></tr>
      </table>
    `);

    expect(result.richHtml).toContain('colspan="2"');
    expect(result.richHtml).toContain('align="center"');
    expect(result.richHtml).toContain('rowspan="2"');
    expect(result.richHtml).toContain('valign="top"');
  });

  it("drops rich-table alignment values outside Telegram's enums", () => {
    const result = renderStructuredEmailHtml(`
      <table>
        <tr><td align="justify" valign="baseline">A</td><td align="center">B</td></tr>
        <tr><td valign="middle">C</td><td>D</td></tr>
      </table>
    `);

    expect(result.richHtml).not.toContain("justify");
    expect(result.richHtml).not.toContain("baseline");
    expect(result.richHtml).toContain('align="center"');
    expect(result.richHtml).toContain('valign="middle"');
  });

  it("keeps one-row multi-column tables semantic", () => {
    const result = renderStructuredEmailHtml(
      "<table><tr><td>Environment</td><td>Production</td></tr></table>",
    );

    expect(result.richHtml).toContain("<table>");
    expect(result.richHtml).toContain("<th>Environment</th>");
  });

  it("uses logical columns for classic record labels across spans", () => {
    const result = renderStructuredEmailHtml(`
      <table>
        <tr><th colspan="2">Identity</th><th>Status</th></tr>
        <tr><td colspan="2">Alice</td><td>Success</td></tr>
      </table>
      <table>
        <tr><th>Name</th><th>Status</th><th>Note</th></tr>
        <tr><td rowspan="2">Alice</td><td>Success</td><td>First</td></tr>
        <tr><td>Failed</td><td>Second</td></tr>
      </table>
    `);

    expect(result.classicHtml).toContain("Status: Success");
    expect(result.classicHtml).toContain("Status: Failed");
    expect(result.classicHtml).toContain("Note: Second");
  });

  it("does not infer an ordinary first data row as a header", () => {
    const result = renderStructuredEmailHtml(`
      <table>
        <tr><td>Alice</td><td>Success</td></tr>
        <tr><td>Bob</td><td>Failed</td></tr>
      </table>
    `);

    expect(result.classicHtml).toContain("Alice");
    expect(result.classicHtml).toContain("Success");
    expect(result.classicHtml).toContain("Bob");
    expect(result.classicHtml).toContain("Failed");
  });

  it("does not infer partially bold data cells as a header", () => {
    const result = renderStructuredEmailHtml(`
      <table>
        <tr><td><b>Alice</b> Smith</td><td><b>Success</b></td></tr>
        <tr><td>Bob Jones</td><td>Failed</td></tr>
      </table>
    `);

    expect(result.classicHtml).toContain("Alice");
    expect(result.classicHtml).toContain("Success");
    expect(result.classicHtml).toContain("Bob");
    expect(result.classicHtml).toContain("Failed");
  });

  it("honors explicit normal font-weight overrides during header inference", () => {
    const result = renderStructuredEmailHtml(`
      <table>
        <tr>
          <td><b>Alice <span style="font-weight: normal">Smith</span></b></td>
          <td style="font-weight: bold; font-weight: 400">Success</td>
        </tr>
        <tr><td>Bob Jones</td><td>Failed</td></tr>
      </table>
    `);

    expect(result.classicHtml).toContain("Alice Smith");
    expect(result.classicHtml).toContain("Success");
    expect(result.classicHtml).toContain("Bob Jones");
    expect(result.classicHtml).toContain("Failed");
  });

  it("renders multi-row table headers as a safe grid", () => {
    const result = renderStructuredEmailHtml(`
      <table>
        <tr><th rowspan="2">Name</th><th colspan="2">Stats</th></tr>
        <tr><th>Size</th><th>Count</th></tr>
        <tr><td>Job</td><td>5 MB</td><td>2</td></tr>
      </table>
    `);

    expect(result.classicHtml).toContain("Name · Stats");
    expect(result.classicHtml).toContain("Size · Count");
    expect(result.classicHtml).toContain("Job · 5 MB · 2");
    expect(result.classicHtml).not.toContain("Stats: Size");
    expect(result.richHtml).toContain('rowspan="2"');
  });

  it("drops active content, remote media, and unsafe links", () => {
    const result = renderStructuredEmailHtml(`
      <script>PAYLOAD_SENTINEL</script><style>.secret { color: red }</style>
      <form><input value="secret">hidden form text</form>
      <p>Safe <img src="https://tracker.example/pixel.png">
      <a href="jav&#x61;script:alert(1)">bad link</a></p>
    `);

    expect(result.classicHtml).toContain("Safe");
    expect(result.classicHtml).toContain("bad link");
    expect(result.classicHtml).not.toMatch(/script|style|form|img|javascript|PAYLOAD_SENTINEL/);
    expect(result.richHtml).not.toContain("<a");
    expect(result.hasLinks).toBe(false);
  });

  it("decodes named entities and preserves non-ASCII and astral text", () => {
    const result = renderStructuredEmailHtml("<p>© &copy; — &mdash; Україна 🚀</p>");

    expect(result.plainText).toBe("© © — — Україна 🚀");
    expect(result.richHtml).toContain("© © — — Україна 🚀");
  });

  it("keeps only validated safe link schemes and reports links", () => {
    const result = renderStructuredEmailHtml(`
      <p><a href="HTTPS://example.com/report?q=1&amp;x=2">report</a>
      <a href="mailto:ops@example.com">mail</a>
      <a href="data:text/plain,secret">data</a></p>
    `);

    expect(result.classicHtml).toContain('href="https://example.com/report?q=1&amp;x=2"');
    expect(result.classicHtml).toContain('href="mailto:ops@example.com"');
    expect(result.classicHtml).not.toContain("data:text");
    expect(result.hasLinks).toBe(true);
  });

  it("uses newlines rather than unsupported br tags in classic output", () => {
    const result = renderStructuredEmailHtml("<p><b>Success</b><br>4 catalogs processed</p>");

    expect(result.classicHtml).toBe("<b>Success</b>\n4 catalogs processed");
    expect(result.classicHtml).not.toContain("<br>");
    expect(result.richHtml).toContain("<b>Success</b><br>4 catalogs processed");
  });

  it("preserves inline whitespace across nested formatting", () => {
    const result = renderStructuredEmailHtml("<p>Hello<b> world</b> again</p>");

    expect(result.classicHtml).toBe("Hello<b> world</b> again");
    expect(result.plainText).toBe("Hello world again");
  });

  it("retains safe anchors inside classic quotes", () => {
    const result = renderStructuredEmailHtml(
      '<blockquote>Open <a href="https://example.com/report">report</a></blockquote>',
    );

    expect(result.classicHtml).toContain(
      '&gt; Open <a href="https://example.com/report">report</a>',
    );
  });

  it("preserves safe link destinations when code and anchors overlap", () => {
    const result = renderStructuredEmailHtml(`
      <p><a href="https://example.com/one"><code>one</code></a></p>
      <p><code><a href="https://example.com/two">two</a></code></p>
    `);

    expect(result.classicHtml).toContain('<a href="https://example.com/one">one</a>');
    expect(result.classicHtml).toContain('<a href="https://example.com/two">two</a>');
    expect(result.classicHtml).not.toContain("<code>");
    expect(result.hasLinks).toBe(true);
  });

  it("never emits nested anchors from malformed source HTML", () => {
    const result = renderStructuredEmailHtml(
      '<p><a href="https://one.example"><b><a href="https://two.example">x</a></b></a></p>',
    );

    expect(result.classicHtml.match(/<a\b/g)).toHaveLength(1);
    expect(result.classicHtml.match(/<\/a>/g)).toHaveLength(1);
    expect(result.classicHtml).toContain('href="https://two.example/"');
  });

  it("keeps nested inline list items separated", () => {
    const result = renderStructuredEmailHtml(`
      <blockquote><ul><li>alpha</li><li>beta</li></ul></blockquote>
      <table><tr><td>Items</td><td><ul><li>one</li><li>two</li></ul></td></tr></table>
    `);

    expect(result.classicHtml).toContain("• alpha");
    expect(result.classicHtml).toContain("• beta");
    expect(result.classicHtml).toContain("• one");
    expect(result.classicHtml).toContain("• two");
    expect(result.classicHtml).not.toMatch(/alphabeta|onetwo/);
  });

  it("detects source URLs next to punctuation", () => {
    const result = renderStructuredEmailHtml("<p>Open(https://example.com/report)</p>");

    expect(result.hasLinks).toBe(true);
  });

  it("reserves preformatted blocks for actual source pre elements", () => {
    const result = renderStructuredEmailHtml(`
      <pre>line 1\nline 2</pre>
      <table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>
    `);

    expect(result.classicHtml.match(/<pre>/g)).toHaveLength(1);
    expect(result.classicHtml).toContain("<pre>line 1\nline 2</pre>");
  });

  it("keeps preformatted source URLs on classic transport", () => {
    const result = renderStructuredEmailHtml("<pre>https://example.com/report</pre>");

    expect(result.hasLinks).toBe(true);
  });

  it("drops document metadata such as head and title", () => {
    const result = renderStructuredEmailHtml(
      "<head><title>Secret title</title></head><body><p>Body</p></body>",
    );

    expect(result.classicHtml).toBe("Body");
    expect(result.classicHtml).not.toContain("Secret title");
  });

  it("retains sparse and long cell values without width truncation", () => {
    const longValue = "A complete value that is much longer than twenty-four characters";
    const result = renderStructuredEmailHtml(`
      <table><tr><th>Name</th><th>Empty</th><th>Details</th></tr>
      <tr><td>Job</td><td></td><td>${longValue}</td></tr></table>
    `);

    expect(result.classicHtml).toContain(longValue);
    expect(result.classicHtml).not.toContain("…");
    expect(result.richHtml).toContain(longValue);
  });

  it("rejects rich output above the decoded text limit", () => {
    const result = renderStructuredEmailHtml(`<p>${"🚀".repeat(32_769)}</p>`);
    expect(result.richHtml).toBeNull();
    expect(result.richIneligibleReason).toBe("text_limit");
  });

  it("rejects rich output above the block limit", () => {
    const result = renderStructuredEmailHtml(
      Array.from({ length: 501 }, (_, index) => `<p>row ${index}</p>`).join(""),
    );
    expect(result.richHtml).toBeNull();
    expect(result.richIneligibleReason).toBe("block_limit");
  });

  it("always reserves an omission notice when the model block cap is exceeded", () => {
    const result = renderStructuredEmailHtml(
      Array.from({ length: 601 }, (_, index) => `<p>row ${index}</p>`).join(""),
    );

    expect(result.classicHtml).toContain("content omitted");
    expect(result.classicHtml).not.toContain("row 600");
  });

  it("measures actual rich nesting and rejects output deeper than sixteen", () => {
    const atLimit = renderStructuredEmailHtml(`<p>${"<b>".repeat(15)}ok${"</b>".repeat(15)}</p>`);
    const tooDeep = renderStructuredEmailHtml(`<p>${"<b>".repeat(16)}deep${"</b>".repeat(16)}</p>`);

    expect(atLimit.stats.outputDepth).toBe(16);
    expect(atLimit.richHtml).not.toBeNull();
    expect(tooDeep.stats.outputDepth).toBe(17);
    expect(tooDeep.richHtml).toBeNull();
    expect(tooDeep.richIneligibleReason).toBe("depth_limit");
  });

  it("rejects rich tables above twenty logical columns after spans", () => {
    const headers = Array.from({ length: 21 }, (_, index) => `<th>H${index}</th>`).join("");
    const values = Array.from({ length: 21 }, (_, index) => `<td>V${index}</td>`).join("");
    const result = renderStructuredEmailHtml(
      `<table><tr>${headers}</tr><tr>${values}</tr></table>`,
    );

    expect(result.richHtml).toBeNull();
    expect(result.richIneligibleReason).toBe("column_limit");
    expect(result.classicHtml).toContain("V20");
  });

  it("bounds excessive depth and malformed input without throwing", () => {
    const deep = `${"<div>".repeat(40)}deep${"</div>".repeat(40)}<table><tr><td>broken`;
    const result = renderStructuredEmailHtml(deep);

    expect(result.richHtml).toBeNull();
    expect(result.richIneligibleReason).toBe("input_limit");
    expect(result.classicHtml).toContain("content omitted");
  });

  it("bounds deep inline trees inside table cells without overflowing the stack", () => {
    const nested = `${"<span>".repeat(5_000)}deep${"</span>".repeat(5_000)}`;
    const source = `<table><tr><td>${nested}</td><td>tail</td></tr><tr><td>A</td><td>B</td></tr></table>`;

    expect(() => renderStructuredEmailHtml(source)).not.toThrow();
    expect(renderStructuredEmailHtml(source).classicHtml).toContain("content omitted");
  });

  it("bounds DOM construction for very large node counts", () => {
    const result = renderStructuredEmailHtml("<i>x</i>".repeat(20_050));

    expect(result.classicHtml).toContain("content omitted");
    expect(result.richIneligibleReason).toBe("input_limit");
  });

  it("distinguishes visible source content from a synthetic omission notice", () => {
    const result = renderStructuredEmailHtml("<img>".repeat(20_001));

    expect(result.classicHtml).toContain("content omitted");
    expect(result.hasVisibleContent).toBe(false);
  });

  it("avoids invalid formatting entities nested around code", () => {
    const result = renderStructuredEmailHtml("<p><b>before <code><i>x</i></code></b></p>");

    expect(result.classicHtml).toContain("before <code>x</code>");
    expect(result.classicHtml).not.toMatch(/<b>[^]*<code>|<code>[^]*<b>/);
  });
});
