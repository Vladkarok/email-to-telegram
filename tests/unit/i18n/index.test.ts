import { describe, it, expect } from "vitest";
import {
  normalizeLocale,
  localeFromTelegram,
  isLocale,
  getMessages,
} from "../../../src/i18n/index.js";

describe("normalizeLocale", () => {
  it("returns 'en' for English codes", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("EN")).toBe("en");
  });

  it("returns 'uk' for Ukrainian codes", () => {
    expect(normalizeLocale("uk")).toBe("uk");
    expect(normalizeLocale("ua")).toBe("uk");
    expect(normalizeLocale("uk-UA")).toBe("uk");
  });

  it("returns 'fr' for French codes", () => {
    expect(normalizeLocale("fr")).toBe("fr");
    expect(normalizeLocale("fr-FR")).toBe("fr");
  });

  it("returns 'it' for Italian codes", () => {
    expect(normalizeLocale("it")).toBe("it");
    expect(normalizeLocale("it-IT")).toBe("it");
  });

  it("returns null for unsupported locales", () => {
    expect(normalizeLocale("de")).toBeNull();
    expect(normalizeLocale("es")).toBeNull();
  });

  it("returns null for null or undefined input", () => {
    expect(normalizeLocale(null)).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
    expect(normalizeLocale("")).toBeNull();
  });
});

describe("localeFromTelegram", () => {
  it("delegates to normalizeLocale", () => {
    expect(localeFromTelegram("en")).toBe("en");
    expect(localeFromTelegram("uk")).toBe("uk");
    expect(localeFromTelegram(null)).toBeNull();
  });
});

describe("isLocale", () => {
  it("returns true for supported locale codes", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("uk")).toBe(true);
    expect(isLocale("fr")).toBe(true);
    expect(isLocale("it")).toBe(true);
  });

  it("returns false for unsupported values", () => {
    expect(isLocale("de")).toBe(false);
    expect(isLocale("")).toBe(false);
  });
});

describe("getMessages", () => {
  it("returns message catalog for each supported locale", () => {
    for (const locale of ["en", "uk", "fr", "it"] as const) {
      const messages = getMessages(locale);
      expect(messages).toBeDefined();
      expect(typeof messages.common).toBe("object");
    }
  });
});
