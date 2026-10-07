import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface Panel {
  id: number;
  title?: string;
  description?: string;
  targets?: Array<{ expr?: string }>;
  panels?: Panel[];
}

const dashboard = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../../../monitoring/grafana/provisioning/dashboards/json/email-to-telegram-app.json",
    ),
    "utf8",
  ),
) as { panels: Panel[] };

function allPanels(panels: Panel[]): Panel[] {
  return panels.flatMap((panel) => [panel, ...allPanels(panel.panels ?? [])]);
}

describe("Operations dashboard", () => {
  it("gives every panel a unique id", () => {
    const ids = allPanels(dashboard.panels).map((panel) => panel.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe("Stale bot updates panel", () => {
    const panel = allPanels(dashboard.panels).find((p) => p.title === "Stale bot updates (24h)");

    it("shows the 24-h increase and the highest process total, which survives a missed first scrape", () => {
      const exprs = (panel?.targets ?? []).map((target) => target.expr);
      expect(exprs).toEqual([
        expect.stringMatching(/^sum\(increase\(email_to_telegram_bot_updates_skipped_total\{/),
        expect.stringMatching(
          /^max_over_time\(sum\(email_to_telegram_bot_updates_skipped_total\{[^}]*\}\)\[24h:/,
        ),
      ]);
    });

    it("names the exact source of the count in its description", () => {
      expect(panel?.description).toContain("telegram.update.stale_skipped");
      expect(panel?.description).toContain("Loki");
    });
  });
});
