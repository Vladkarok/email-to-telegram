import { describe, it, expect } from "vitest";
import { monthStart, nextMonthStart } from "../../../../src/db/repos/deliveryLogs.js";

describe("monthStart", () => {
  it("returns the first of January UTC for 2026-01", () => {
    const d = monthStart("2026-01");
    expect(d.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns the first of April UTC for 2026-04", () => {
    const d = monthStart("2026-04");
    expect(d.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("returns the first of December UTC for 2026-12", () => {
    const d = monthStart("2026-12");
    expect(d.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("returns the first of February UTC (non-leap year)", () => {
    const d = monthStart("2025-02");
    expect(d.toISOString()).toBe("2025-02-01T00:00:00.000Z");
  });

  it("returns the first of February UTC (leap year)", () => {
    const d = monthStart("2024-02");
    expect(d.toISOString()).toBe("2024-02-01T00:00:00.000Z");
  });

  it("throws for invalid format", () => {
    expect(() => monthStart("2026-4")).toThrow("YYYY-MM");
    expect(() => monthStart("26-04")).toThrow("YYYY-MM");
    expect(() => monthStart("2026/04")).toThrow("YYYY-MM");
  });

  it("throws for month 00", () => {
    expect(() => monthStart("2026-00")).toThrow("out of range");
  });

  it("throws for month 13", () => {
    expect(() => monthStart("2026-13")).toThrow("out of range");
  });
});

describe("nextMonthStart", () => {
  it("advances from April to May within the same year", () => {
    const d = nextMonthStart("2026-04");
    expect(d.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("rolls over from December to January of the next year", () => {
    const d = nextMonthStart("2026-12");
    expect(d.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("advances from January to February (non-leap year)", () => {
    const d = nextMonthStart("2025-01");
    expect(d.toISOString()).toBe("2025-02-01T00:00:00.000Z");
  });

  it("advances from January to February (leap year)", () => {
    const d = nextMonthStart("2024-01");
    expect(d.toISOString()).toBe("2024-02-01T00:00:00.000Z");
  });

  it("produces a half-open interval: nextMonthStart > monthStart", () => {
    const start = monthStart("2026-04");
    const end = nextMonthStart("2026-04");
    expect(end.getTime()).toBeGreaterThan(start.getTime());
    // Exactly one calendar month apart (April has 30 days)
    expect(end.getTime() - start.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("Dec→Jan interval is exactly 31 days", () => {
    const start = monthStart("2026-12");
    const end = nextMonthStart("2026-12");
    expect(end.getTime() - start.getTime()).toBe(31 * 24 * 60 * 60 * 1000);
  });

  it("Feb 2024 (leap) interval is exactly 29 days", () => {
    const start = monthStart("2024-02");
    const end = nextMonthStart("2024-02");
    expect(end.getTime() - start.getTime()).toBe(29 * 24 * 60 * 60 * 1000);
  });

  it("Feb 2025 (non-leap) interval is exactly 28 days", () => {
    const start = monthStart("2025-02");
    const end = nextMonthStart("2025-02");
    expect(end.getTime() - start.getTime()).toBe(28 * 24 * 60 * 60 * 1000);
  });
});
