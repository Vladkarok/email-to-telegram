/**
 * Locale identifiers and normalization. Leaf module with no project imports
 * so lower layers (db repos) can share it without pulling in the message
 * catalogs — i18n/index.ts re-exports everything here.
 */
export const SUPPORTED_LOCALES = ["en", "uk", "fr", "it"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace("_", "-");
  const [language] = normalized.split("-");
  if (language === "uk" || language === "ua") return "uk";
  if (language === "en") return "en";
  if (language === "fr") return "fr";
  if (language === "it") return "it";
  return null;
}

export function localeFromTelegram(value: string | null | undefined): Locale | null {
  return normalizeLocale(value);
}
