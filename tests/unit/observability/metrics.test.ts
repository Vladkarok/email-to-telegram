import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  metricsRegistry,
  readAppVersion,
  recordDeliveryLatency,
  recordInboundPreflight,
  resetMetricsForTests,
} from "../../../src/observability/metrics.js";

async function exposition(name: string): Promise<string> {
  return metricsRegistry.getSingleMetricAsString(name);
}

function sample(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : undefined;
}

const LATENCY = "email_to_telegram_delivery_latency_seconds";

describe("recordDeliveryLatency", () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  it("observes seconds from received_at, per path", async () => {
    const receivedAt = new Date("2026-10-06T10:00:00.000Z");
    recordDeliveryLatency("initial", receivedAt, new Date("2026-10-06T10:00:01.500Z"));
    recordDeliveryLatency("retry", receivedAt, new Date("2026-10-06T10:07:00.000Z"));

    const text = await exposition(LATENCY);
    expect(sample(text, /_count\{[^}]*path="initial"[^}]*\} (\d+)/)).toBe(1);
    expect(sample(text, /_sum\{[^}]*path="initial"[^}]*\} ([\d.]+)/)).toBe(1.5);
    expect(sample(text, /_bucket\{le="1",[^}]*path="initial"[^}]*\} (\d+)/)).toBe(0);
    expect(sample(text, /_bucket\{le="2",[^}]*path="initial"[^}]*\} (\d+)/)).toBe(1);
    expect(sample(text, /_count\{[^}]*path="retry"[^}]*\} (\d+)/)).toBe(1);
    expect(sample(text, /_sum\{[^}]*path="retry"[^}]*\} ([\d.]+)/)).toBe(420);
  });

  it("clamps clock skew to 0 instead of a negative latency", async () => {
    recordDeliveryLatency(
      "initial",
      new Date("2026-10-06T10:00:05.000Z"),
      new Date("2026-10-06T10:00:00.000Z"),
    );

    const text = await exposition(LATENCY);
    expect(sample(text, /_count\{[^}]*path="initial"[^}]*\} (\d+)/)).toBe(1);
    expect(sample(text, /_sum\{[^}]*path="initial"[^}]*\} ([\d.]+)/)).toBe(0);
  });

  it("drops a missing or invalid received_at without throwing", async () => {
    expect(() => recordDeliveryLatency("initial", new Date("not a date"))).not.toThrow();
    expect(() =>
      recordDeliveryLatency("retry", undefined as unknown as Date, new Date()),
    ).not.toThrow();

    const text = await exposition(LATENCY);
    expect(sample(text, /_count\{[^}]*path="initial"[^}]*\} (\d+)/)).toBe(0);
    expect(sample(text, /_count\{[^}]*path="retry"[^}]*\} (\d+)/)).toBe(0);
  });
});

describe("readAppVersion", () => {
  it("reads the version from package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "etg-version-"));
    const file = join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ name: "x", version: "9.8.7" }));
    expect(readAppVersion(pathToFileURL(file))).toBe("9.8.7");
  });

  it("falls back to unknown when the file is missing or has no version", () => {
    const dir = mkdtempSync(join(tmpdir(), "etg-version-"));
    expect(readAppVersion(pathToFileURL(join(dir, "missing.json")))).toBe("unknown");
    const file = join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ name: "x" }));
    expect(readAppVersion(pathToFileURL(file))).toBe("unknown");
  });
});

describe("resetMetricsForTests", () => {
  it("restores the zero-initialised series and build info after clearing", async () => {
    recordInboundPreflight("deferred", "rate_limited");
    resetMetricsForTests();

    const preflight = await exposition("email_to_telegram_inbound_preflight_total");
    expect(preflight).toMatch(/\{result="deferred",reason="rate_limited"[^}]*\} 0$/m);
    const buildInfo = await exposition("email_to_telegram_build_info");
    expect(buildInfo).toMatch(/\{version="[^"]+"[^}]*\} 1/);
  });
});
