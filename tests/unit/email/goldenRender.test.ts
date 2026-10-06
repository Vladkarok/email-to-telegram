import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEmail } from "../../../src/email/parser.js";
import { renderEmailForDelivery } from "../../../src/email/renderer.js";

/**
 * Golden rendering tests over real .eml files.
 *
 * Every `tests/fixtures/golden/<name>.eml` is parsed and rendered exactly as
 * the delivery pipeline does, in html mode, and compared byte for byte with
 * `<name>.classic.txt` and `<name>.rich.html` next to it. A rendering change
 * therefore shows up as a readable diff of what Telegram would receive.
 *
 * Refresh after an intentional change:  UPDATE_GOLDEN=1 npx vitest run goldenRender
 *
 * Fixtures must be redacted (example.com addresses, no real hostnames) because
 * this directory is public.
 */
const dir = path.resolve(__dirname, "../../fixtures/golden");
const update = process.env["UPDATE_GOLDEN"] === "1";

async function expectGolden(file: string, actual: string): Promise<void> {
  if (update) {
    await writeFile(file, actual);
    return;
  }
  const expected = await readFile(file, "utf8").catch(() => null);
  expect(
    expected,
    `missing golden ${path.basename(file)}; run with UPDATE_GOLDEN=1`,
  ).not.toBeNull();
  expect(actual).toBe(expected);
}

const emls = (await readdir(dir)).filter((f) => f.endsWith(".eml")).sort();

describe("golden rendering of real emails", () => {
  it("has at least one fixture", () => {
    expect(emls.length).toBeGreaterThan(0);
  });

  for (const eml of emls) {
    const name = eml.slice(0, -".eml".length);
    it(`renders ${name} as recorded`, async () => {
      const raw = await readFile(path.join(dir, eml));
      const parsed = await parseEmail(raw, raw.length);
      const rendered = renderEmailForDelivery(parsed, "html", "alias@example.net", []);
      await expectGolden(path.join(dir, `${name}.classic.txt`), rendered.text);
      await expectGolden(path.join(dir, `${name}.rich.html`), rendered.richHtml ?? "");
    });
  }
});
