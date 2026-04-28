import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_DEFINITIONS, type PlanCode } from "../../../src/billing/plans.js";

interface PricingRow {
  plan: string;
  monthly: string;
  yearly: string;
  users: string;
  chats: string;
  aliases: string;
  allowRules: string;
  emailsMonth: string;
  egressMonth: string;
  storage: string;
  messageSize: string;
  retention: string;
  customDomains: string;
}

const pricingDoc = resolve(process.cwd(), "docs/hosted/pricing-and-terms.md");

describe("hosted pricing documentation", () => {
  it("keeps the public pricing table aligned with plan definitions", () => {
    const rows = parsePricingRows(readFileSync(pricingDoc, "utf8"));
    const expectedPlanNames = Object.values(PLAN_DEFINITIONS)
      .map((plan) => plan.name)
      .sort();

    expect(Object.keys(rows).sort()).toEqual(expectedPlanNames);

    for (const code of Object.keys(PLAN_DEFINITIONS) as PlanCode[]) {
      const plan = PLAN_DEFINITIONS[code];
      expect(rows[plan.name]).toEqual({
        plan: plan.name,
        monthly: formatPrice(plan.monthlyPriceUsd),
        yearly: formatPrice(plan.yearlyPriceUsd),
        users: formatNumber(plan.limits.users),
        chats: formatNumber(plan.limits.chats),
        aliases: formatNumber(plan.limits.aliases),
        allowRules: formatNumber(plan.limits.allowRules),
        emailsMonth: formatNumber(plan.limits.deliveredEmailsMonth),
        egressMonth: formatBytes(plan.limits.egressBytesMonth),
        storage: formatBytes(plan.limits.storageBytes),
        messageSize: formatBytes(plan.limits.maxMessageBytes),
        retention: `${formatNumber(plan.limits.retentionDays)} days`,
        customDomains: formatNumber(plan.limits.customDomains),
      });
    }
  });
});

function parsePricingRows(markdown: string): Record<string, PricingRow> {
  const match = markdown.match(
    /<!-- pricing-table:start -->\n(?<table>[\s\S]+?)\n<!-- pricing-table:end -->/,
  );
  if (!match?.groups?.["table"]) throw new Error("pricing table markers not found");

  const rows: Record<string, PricingRow> = {};
  const lines = match.groups["table"]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));

  for (const line of lines.slice(2)) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 13) throw new Error(`unexpected pricing row shape: ${line}`);

    const [
      plan,
      monthly,
      yearly,
      users,
      chats,
      aliases,
      allowRules,
      emailsMonth,
      egressMonth,
      storage,
      messageSize,
      retention,
      customDomains,
    ] = cells;

    const row: PricingRow = {
      plan,
      monthly,
      yearly,
      users,
      chats,
      aliases,
      allowRules,
      emailsMonth,
      egressMonth,
      storage,
      messageSize,
      retention,
      customDomains,
    };
    rows[row.plan] = row;
  }

  return rows;
}

function formatPrice(price: number | null): string {
  return price == null ? "Contact us" : `$${price}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatBytes(value: number): string {
  const mib = 1024 * 1024;
  const gib = 1024 * mib;
  if (value % gib === 0) {
    const gb = value / gib;
    return `${formatNumber(gb)} GB`;
  }
  if (value % mib === 0) return `${value / mib} MB`;
  return `${value} B`;
}
