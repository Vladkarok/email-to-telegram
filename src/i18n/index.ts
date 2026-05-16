import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { findUserById } from "../db/repos/users.js";
import { en } from "./locales/en.js";
import { uk } from "./locales/uk.js";
import { fr } from "./locales/fr.js";
import { it } from "./locales/it.js";

export const SUPPORTED_LOCALES = ["en", "uk", "fr", "it"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result
    : T extends object
      ? { readonly [Key in keyof T]: Widen<T[Key]> }
      : T;
export type Messages = Widen<typeof en>;

export const DEFAULT_LOCALE: Locale = "en";

const catalogs: Record<Locale, Messages> = { en, uk, fr, it };

export function getMessages(locale: Locale): Messages {
  return catalogs[locale];
}

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

export async function resolveLocale(
  ctx: Context,
  db?: NodePgDatabase<typeof schema>,
): Promise<Locale> {
  const fallback = localeFromTelegram(ctx.from?.language_code) ?? DEFAULT_LOCALE;
  if (!ctx.from || !db) return fallback;

  try {
    const user = await findUserById(db, BigInt(ctx.from.id));
    return normalizeLocale(user?.locale) ?? fallback;
  } catch {
    return fallback;
  }
}
