import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { findUserById } from "../db/repos/users.js";
import { en } from "./locales/en.js";
import { uk } from "./locales/uk.js";
import { fr } from "./locales/fr.js";
import { it } from "./locales/it.js";
import { DEFAULT_LOCALE, localeFromTelegram, normalizeLocale, type Locale } from "./locale.js";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isLocale,
  localeFromTelegram,
  normalizeLocale,
  type Locale,
} from "./locale.js";

type Widen<T> = T extends string
  ? string
  : T extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result
    : T extends object
      ? { readonly [Key in keyof T]: Widen<T[Key]> }
      : T;
export type Messages = Widen<typeof en>;

const catalogs: Record<Locale, Messages> = { en, uk, fr, it };

export function getMessages(locale: Locale): Messages {
  return catalogs[locale];
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
