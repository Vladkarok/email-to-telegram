/**
 * Centralised inline-keyboard callback registry.
 *
 * Every callback action string and pattern in the bot is defined here.
 * Handlers in bot.ts, command files, and menu files MUST reference these
 * constants rather than hard-coding callback strings.
 *
 * Naming conventions:
 *   Static callbacks  — plain string, e.g. CALLBACKS.CHAT_SELECTION
 *   Parametric callbacks — object with { pattern, build } where
 *       pattern  is the RegExp passed to bot.callbackQuery()
 *       build    produces the data string embedded in InlineKeyboard.text()
 *
 * Round-trip guarantee: pattern.test(build(...args)) === true for all inputs.
 */

// ─── Static callbacks ─────────────────────────────────────────────────────────

/** Back to chat selection list. */
export const CB_CHAT_SELECTION = "cs";

/** Cancel pending new-email flow. */
export const CB_NEW_CANCEL = "nc";

/** Billing: open upgrade plan selector. */
export const CB_BILLING_UPGRADE = "bill:upgrade";

/** Billing: open customer portal. */
export const CB_BILLING_PORTAL = "bill:portal";

// ─── Parametric callback helpers ──────────────────────────────────────────────

/** Chat management menu — cm:{chatId} */
export const CB_CHAT_MENU = {
  pattern: /^cm:(-?\d+)$/,
  build: (chatId: bigint | string): string => `cm:${chatId}`,
} as const;

/** Alias list for a chat — cl:{chatId} */
export const CB_ALIAS_LIST = {
  pattern: /^cl:(-?\d+)$/,
  build: (chatId: bigint | string): string => `cl:${chatId}`,
} as const;

/** Start new-email flow for a chat — cn:{chatId} */
export const CB_NEW_EMAIL = {
  pattern: /^cn:(-?\d+)$/,
  build: (chatId: bigint | string): string => `cn:${chatId}`,
} as const;

/** Skip to random alias — ns:{chatId} */
export const CB_SKIP_ALIAS = {
  pattern: /^ns:(-?\d+)$/,
  build: (chatId: bigint | string): string => `ns:${chatId}`,
} as const;

/** Alias detail menu — am:{aliasId} */
export const CB_ALIAS_DETAIL = {
  pattern: /^am:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `am:${aliasId}`,
} as const;

/** Pause alias — ap:{aliasId} */
export const CB_ALIAS_PAUSE = {
  pattern: /^ap:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `ap:${aliasId}`,
} as const;

/** Resume alias — ar:{aliasId} */
export const CB_ALIAS_RESUME = {
  pattern: /^ar:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `ar:${aliasId}`,
} as const;

/** Delete alias — ad:{aliasId} */
export const CB_ALIAS_DELETE = {
  pattern: /^ad:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `ad:${aliasId}`,
} as const;

/**
 * Confirm alias delete — adc:{aliasId}:{routingVersion}
 *
 * The version is baked in when the confirmation screen is rendered. Re-reading
 * it at click time would defeat the CAS entirely: the delete would always
 * match current state and could silently win a move-vs-delete race.
 */
export const CB_ALIAS_DELETE_CONFIRM = {
  pattern: /^adc:([0-9a-f-]{36}):(\d+)$/,
  build: (aliasId: string, version: number): string => `adc:${aliasId}:${version}`,
} as const;

/** Cancel alias delete — adx:{aliasId} */
export const CB_ALIAS_DELETE_CANCEL = {
  pattern: /^adx:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `adx:${aliasId}`,
} as const;

/** Orphan recovery menu for an unreachable-chat alias — orp:{aliasId} */
export const CB_ALIAS_ORPHAN = {
  pattern: /^orp:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `orp:${aliasId}`,
} as const;

/** Confirm orphan delete — orpd:{aliasId}:{routingVersion} */
export const CB_ALIAS_ORPHAN_DELETE = {
  pattern: /^orpd:([0-9a-f-]{36}):(\d+)$/,
  build: (aliasId: string, version: number): string => `orpd:${aliasId}:${version}`,
} as const;

/** Open move picker — mv:{aliasId} */
export const CB_ALIAS_MOVE = {
  pattern: /^mv:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `mv:${aliasId}`,
} as const;

/**
 * Move target chosen — mt:{aliasId}:{chatId}:{routingVersion}
 *
 * The routing version travels with the callback so the confirmation stays
 * bound to the alias state it was authorized against.
 */
export const CB_ALIAS_MOVE_TARGET = {
  pattern: /^mt:([0-9a-f-]{36}):(-?\d+):(\d+)$/,
  build: (aliasId: string, chatId: bigint | string, version: number): string =>
    `mt:${aliasId}:${chatId}:${version}`,
} as const;

/** Confirmed move — mc:{aliasId}:{chatId}:{routingVersion} */
export const CB_ALIAS_MOVE_CONFIRM = {
  pattern: /^mc:([0-9a-f-]{36}):(-?\d+):(\d+)$/,
  build: (aliasId: string, chatId: bigint | string, version: number): string =>
    `mc:${aliasId}:${chatId}:${version}`,
} as const;

/** Deliver in the current forum topic — tp:{aliasId}:{routingVersion} */
export const CB_ALIAS_SET_TOPIC = {
  pattern: /^tp:([0-9a-f-]{36}):(\d+)$/,
  build: (aliasId: string, version: number): string => `tp:${aliasId}:${version}`,
} as const;

/** Alias settings — ac:{aliasId} */
export const CB_ALIAS_SETTINGS = {
  pattern: /^ac:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `ac:${aliasId}`,
} as const;

/** Start label-edit flow — ale:{aliasId} */
export const CB_ALIAS_LABEL_EDIT = {
  pattern: /^ale:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `ale:${aliasId}`,
} as const;

/** Clear label — alc:{aliasId} */
export const CB_ALIAS_LABEL_CLEAR = {
  pattern: /^alc:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `alc:${aliasId}`,
} as const;

/** Cancel label-edit flow — alx:{aliasId} */
export const CB_ALIAS_LABEL_CANCEL = {
  pattern: /^alx:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `alx:${aliasId}`,
} as const;

/** Quick-add allow domain — qa:{aliasId}:{domain} */
export const CB_QUICK_ALLOW = {
  pattern: /^qa:([0-9a-f-]{36}):(.+)$/,
  build: (aliasId: string, domain: string): string => `qa:${aliasId}:${domain}`,
} as const;

/** Quick-add allow domain and return to allow-rules menu — qr:{aliasId}:{domain} */
export const CB_QUICK_ALLOW_RULES = {
  pattern: /^qr:([0-9a-f-]{36}):(.+)$/,
  build: (aliasId: string, domain: string): string => `qr:${aliasId}:${domain}`,
} as const;

/** Set render mode — set_mode:{aliasId}:{mode} */
export const CB_SET_MODE = {
  pattern: /^set_mode:(.+):(.+)$/,
  build: (aliasId: string, mode: string): string => `set_mode:${aliasId}:${mode}`,
} as const;

/** Toggle body dedup — toggle_body_dedup:{aliasId} */
export const CB_TOGGLE_BODY_DEDUP = {
  pattern: /^toggle_body_dedup:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `toggle_body_dedup:${aliasId}`,
} as const;

/** Toggle privacy mode — toggle_privacy_mode:{aliasId} */
export const CB_TOGGLE_PRIVACY_MODE = {
  pattern: /^toggle_privacy_mode:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `toggle_privacy_mode:${aliasId}`,
} as const;

/** Allow rules menu — al:{aliasId} */
export const CB_ALLOW_RULES = {
  pattern: /^al:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `al:${aliasId}`,
} as const;

/** Delete allow rule — dr:{ruleId} */
export const CB_DELETE_RULE = {
  pattern: /^dr:([0-9a-f-]{36})$/,
  build: (ruleId: string): string => `dr:${ruleId}`,
} as const;

/** Start add-allow-rule flow — aa:{aliasId} */
export const CB_ADD_RULE = {
  pattern: /^aa:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `aa:${aliasId}`,
} as const;

/** Cancel add-allow-rule flow — na:{aliasId} */
export const CB_CANCEL_ADD_RULE = {
  pattern: /^na:([0-9a-f-]{36})$/,
  build: (aliasId: string): string => `na:${aliasId}`,
} as const;

/** Upgrade plan selection — upg:{priceKey} */
export const CB_UPGRADE_PLAN = {
  pattern: /^upg:(.+)$/,
  build: (priceKey: string): string => `upg:${priceKey}`,
} as const;

/** Set bot language — lang:{locale} */
export const CB_LANGUAGE_SET = {
  pattern: /^lang:(en|uk|fr|it)$/,
  build: (locale: "en" | "uk" | "fr" | "it"): string => `lang:${locale}`,
} as const;

/** Close (dismiss) the language menu */
export const CB_LANGUAGE_CLOSE = "lang:close";

/** /delete_me confirmation — delete account */
export const CB_DELETE_ME_CONFIRM = "delme:c";

/** /delete_me confirmation — cancel */
export const CB_DELETE_ME_CANCEL = "delme:x";
