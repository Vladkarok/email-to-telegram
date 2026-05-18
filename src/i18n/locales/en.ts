export const en = {
  localeName: "English",
  language: {
    choose: "<b>Language</b>\n\nChoose the language I should use for bot messages.",
    current: (name: string) => `Current language: <b>${name}</b>`,
    saved: (name: string) => `Language set to ${name}.`,
    unavailable:
      "Language selection is temporarily unavailable while the database migration is pending.",
    buttonEnglish: "English",
    buttonUkrainian: "Українська",
    buttonFrench: "Français",
    buttonItalian: "Italiano",
    closeButton: "✖ Close",
    invalidLanguage: "Invalid language.",
  },
  common: {
    accessDenied: "⛔ Access denied.",
    tooManyRequests: "⚠️ Too many requests. Please slow down.",
    hostedAccountInactive: "⛔ Your hosted account is not ready for alias creation right now.",
    aliasCreationUnavailable:
      "❌ Alias creation is not available right now. Please try again later.",
    noHostedAccount: "❌ No hosted account found. Use /start to set one up.",
    aliasNotFound: "❌ Alias not found.",
    aliasNotFoundShort: "Alias not found.",
    chatNotFoundShort: "Chat not found.",
    ruleNotFoundShort: "Rule not found.",
  },
  start: {
    openDmButton: "💬 Open DM",
    privateChatRedirect: "Manage email aliases in our private chat 👇",
    dmTitle: (name: string) => `🏠 ${name} (DM)`,
    privacyDisclaimer:
      "ℹ️ By using this bot you agree to our data handling. Use /privacy to view the policy, /delete_me to remove your data at any time.",
  },
  chatMenu: {
    welcomePrefix: "👋 Welcome! All email aliases are managed here.\n\n",
    noChats:
      "No chats registered yet.\n\nAdd me to a group to manage email aliases for it, or use me here in DM.",
    noChatsEdit: "No chats registered yet.\n\nAdd me to a group to manage email aliases for it.",
    selectChat: "Select a chat to manage:",
    planFooter: (planName: string, used: number, limit: number) =>
      `Plan: ${planName} | ${used}/${limit} aliases used`,
    newEmailButton: "📧 New Email",
    listEmailsButton: "📋 List Emails",
    backButton: "⬅️ Back",
    managing: (chatTitle: string) => `Managing: <b>${chatTitle}</b>`,
  },
  help: {
    billingStripe: `<b>Billing (hosted only)</b>
/billing — account billing status with Upgrade and Manage Billing buttons
/plan — show your current plan and limits
/usage — show this month's accepted/delivered/failed/rejected counts and quotas
/upgrade — choose a plan and get a Stripe checkout link
/portal — open the Stripe billing portal to manage your subscription`,
    billingManual: `<b>Plan and usage</b>
/billing — account plan and quota status
/plan — show your current plan and limits
/usage — show this month's accepted/delivered/failed/rejected counts and quotas`,
    text: (billingSection: string, settingsHelp: string, safetyNotes: string) => `<b>📖 Help</b>

<b>Menu</b>
/start — open the management menu
/language — choose bot language

<b>Aliases</b>
/newemail — create a new email alias
/newemail &lt;alias&gt; — create one immediately with a specific name
/listemail — list all your aliases
/pauseemail &lt;alias&gt; — pause an alias
/resumeemail &lt;alias&gt; — resume a paused alias
/deleteemail &lt;alias&gt; — delete an alias
/settings &lt;alias&gt; — change render mode, body dedup, or privacy mode

${settingsHelp}

<b>Allow rules</b>
Only senders matching an allow rule can deliver mail to an alias.
/allow list &lt;alias&gt;
/allow add &lt;alias&gt; &lt;email_or_domain&gt;
/allow remove &lt;alias&gt; &lt;email_or_domain&gt;
${billingSection}
/donate — support the project
/help — show this message

${safetyNotes}

💡 After creating an alias, add at least one allow rule — otherwise all mail is rejected.`,
  },
  renderGuidance: {
    plaintextGuidance: "Plaintext: send literal text exactly as typed.",
    htmlGuidance: "HTML: use your mail client's rich-text toolbar. Do not type raw HTML tags.",
    markdownGuidance: "Markdown: type markdown syntax literally. Do not use the rich-text toolbar.",
    bodyDedupOn:
      "Body dedup: on. Future emails with the same body may be suppressed for this alias. Message-ID duplicates are still blocked when that header is present.",
    bodyDedupOff:
      "Body dedup: off. Repeated alerts with the same body still deliver. Recommended for alarm aliases. Message-ID duplicates are still blocked when that header is present.",
    privacyOn:
      "Privacy mode: on. Telegram gets a minimal alert and a browser view link. The email body stays out of Telegram, and attachment downloads are generated only after the browser view is opened.",
    privacyOff:
      "Privacy mode: off. Telegram receives the rendered email body and any attachment handling allowed by the alias settings.",
    renderModeHelp: [
      "<b>Render Modes</b>",
      "plaintext — sends literal text exactly as typed",
      "html — use Gmail or mail-client formatting buttons, not raw <code>&lt;b&gt;</code> tags",
      "markdown — type markdown syntax literally, not the rich-text toolbar",
    ].join("\n"),
    bodyDedupHelp: [
      "<b>Body Dedup</b>",
      "Message-ID duplicates are still blocked when that header is present",
      "new aliases default to body dedup off",
      "body dedup off — repeated alerts with the same body still deliver (recommended for alarm aliases)",
      "body dedup on — future emails with the same body may be suppressed for that alias",
    ].join("\n"),
    privacyModeHelp: [
      "<b>Privacy Mode</b>",
      "privacy off — Telegram receives the rendered email body",
      "privacy on — Telegram receives only a minimal alert and a browser view link",
      "opening that link in the browser asks for one more confirmation before the email body is revealed",
    ].join("\n"),
    safety: [
      "<b>Safety Notes</b>",
      "Use this for operational alerts and convenience forwarding, not for secrets or regulated/confidential data.",
      "Mail content may be visible to the VPS operator, backups, Telegram chat members, and anyone with access to the bot or destination chat.",
      "Do not rely on Telegram forwarding as your only life-safety or paging channel.",
    ].join("\n"),
  },
  newemail: {
    autoNameButton: "⏭ Auto name",
    cancelButton: "✖ Cancel",
    customDomainButton: "✏️ Custom domain…",
    manageAliasButton: "⚙️ Manage alias",
    prompt: (chatTitle: string) =>
      `📧 Creating alias for <b>${chatTitle}</b>\n\n` +
      "Send an alias name (e.g. <code>alerts</code>), or tap Auto name to use a friendly default like <code>inbox</code>.",
    nameTooLong: "❌ Name too long. Max 32 characters.",
    invalidName:
      "❌ Invalid name. Only lowercase letters, digits, dots, hyphens and underscores are allowed.",
    sharedDomainUnavailable: "⛔ Your hosted account is not ready for alias creation right now.",
    uniqueNameFailed: "❌ Could not pick a unique alias name. Try a different one.",
    created: (fullAddress: string, chatNote: string) =>
      `✅ Email alias created!\n\n📧 <code>${fullAddress}</code>${chatNote}\n\n⚠️ All mail is rejected until you allow at least one sender.\nTap a quick pick or add a custom domain:`,
    deliveringTo: (chatTitle: string) => `\nDelivering to: <b>${chatTitle}</b>`,
    aliasLimitReached: (used: number | undefined, limit: number) =>
      `📦 Plan limit reached: ${used ?? limit}/${limit} aliases used. Upgrade to create more aliases.`,
    upgradePlanButton: "⬆️ Upgrade Plan",
    cancelledToast: "Cancelled.",
    invalidAllowFormat:
      "❌ Invalid format. Use a domain (e.g. <code>github.com</code>) or email (e.g. <code>user@example.com</code>).",
  },
  listemail: {
    noAliasesForChat: "📭 No aliases for this chat.\n\nCreate one with /newemail <name>",
    noAliases: "📭 No aliases yet.\n\nUse /start to create one.",
    aliasesForChat: (count: number) => `📬 Aliases for this chat (${count}):`,
    allAliases: (count: number) => `📬 All your aliases (${count}):`,
    manageHint: "<i>Tap an alias below to manage it.</i>",
  },
  aliasMenu: {
    createFirstButton: "📧 Create First Email",
    emptyHeader: (chatTitle: string) => `📭 <b>${chatTitle}</b>\n\nNo aliases yet.`,
    listHeader: (chatTitle: string, count: number) =>
      `📬 <b>${chatTitle}</b> — ${count} alias(es)\n\nTap an alias to manage it.`,
    statusActive: "active",
    statusPaused: "paused",
    statusDeleted: "deleted",
    allowRulesHeader: "<b>Allow rules:</b>",
    allowRulesEmpty: "⚠️ None — all mail rejected",
    detailLines: (params: {
      label: string | null;
      address: string;
      statusIcon: string;
      statusText: string;
      renderMode: string;
      privacyOn: boolean;
      bodyDedupOn: boolean;
      rulesText: string;
    }) => {
      const labelLine = params.label ? `🏷️ <b>${params.label}</b>\n` : "";
      return (
        labelLine +
        `📧 <code>${params.address}</code>\n` +
        `Status: ${params.statusIcon} ${params.statusText}\n` +
        `Render: <code>${params.renderMode}</code>\n` +
        `Privacy mode: <code>${params.privacyOn ? "on" : "off"}</code>\n` +
        `Body dedup: <code>${params.bodyDedupOn ? "on" : "off"}</code>\n\n` +
        `<b>Allow rules:</b>\n${params.rulesText}`
      );
    },
    pauseButton: "⏸ Pause",
    resumeButton: "▶️ Resume",
    deleteButton: "🗑 Delete",
    allowRulesButton: "📋 Allow Rules",
    settingsButton: "⚙️ Settings",
    editLabelButton: "✏️ Edit Label",
    clearLabelButton: "🧹 Clear Label",
    setLabelButton: "🏷️ Set Label",
    backButton: "⬅️ Back",
    deleteConfirmHeader: (address: string) =>
      `⚠️ Delete this email alias?\n\n📧 <code>${address}</code>\n\nFuture emails sent to this address will be rejected.`,
    deleteConfirmYes: "🗑 Yes, delete",
    deleteConfirmCancel: "⬅️ Keep alias",
  },
  allowRulesMenu: {
    addRuleButton: "➕ Add Rule",
    backButton: "⬅️ Back",
    headerEmpty: (localPart: string) =>
      `📋 <b>${localPart}</b> — Allow Rules\n\n⚠️ No rules — all mail is rejected.\n\nAdd at least one domain or email to start receiving mail.`,
    headerWithRules: (localPart: string, count: number) =>
      `📋 <b>${localPart}</b> — ${count} allow rule(s)\n\nTap ❌ to remove a rule.`,
  },
  aliasResolver: {
    ambiguous: (input: string) =>
      `❌ Alias <code>${input}</code> matches more than one inbox. Use the full address (name@domain.tld) to disambiguate.`,
    forbidden: "⛔ Access denied.",
    notFoundDm: (input: string) =>
      `❌ Alias <code>${input}</code> not found. See /listemail for your aliases.`,
    notFoundGroup: (input: string) =>
      `❌ Alias <code>${input}</code> not found in this chat. See /listemail.`,
  },
  aliasActions: {
    deleteUsage: "Usage: /deleteemail <alias-name>",
    deleted: (address: string) =>
      `🗑 Alias <code>${address}</code> deleted. Future emails will be rejected.`,
    pauseUsage: "Usage: /pauseemail <alias-name>",
    alreadyPaused: (address: string) => `⏸ Alias <code>${address}</code> is already paused.`,
    paused: (address: string) =>
      `⏸ Alias <code>${address}</code> paused. Emails will be rejected until resumed.`,
    resumeUsage: "Usage: /resumeemail <alias-name>",
    alreadyActive: (address: string) => `✅ Alias <code>${address}</code> is already active.`,
    resumed: (address: string) =>
      `▶️ Alias <code>${address}</code> resumed. Emails will be delivered again.`,
    pausedToast: "Paused.",
    resumedToast: "Resumed.",
    deletedToast: "Deleted.",
    keptToast: "Kept.",
    cancelledToast: "Cancelled.",
  },
  settingsCommand: {
    usage: [
      "Usage: /settings <alias-name> [plaintext|html|markdown]",
      "Usage: /settings <alias-name> dedup <on|off>",
      "Usage: /settings <alias-name> privacy <on|off>",
    ].join("\n"),
    renderModeSet: (address: string, mode: string, guidance: string) =>
      `✅ Render mode for <code>${address}</code> set to <b>${mode}</b>.\n${guidance}`,
    bodyDedupSet: (address: string, on: boolean, guidance: string) =>
      `✅ Body dedup for <code>${address}</code> set to <b>${on ? "on" : "off"}</b>.\n${guidance}`,
    privacySet: (address: string, on: boolean, guidance: string) =>
      `✅ Privacy mode for <code>${address}</code> set to <b>${on ? "on" : "off"}</b>.\n${guidance}`,
    header: (address: string) => `⚙️ Settings for <code>${address}</code>`,
    renderModeLine: (mode: string) => `Render mode: <b>${mode}</b>`,
    privacyLine: (on: boolean) => `Privacy mode: <b>${on ? "on" : "off"}</b>`,
    bodyDedupLine: (on: boolean) => `Body dedup: <b>${on ? "on" : "off"}</b>`,
    privacyButton: "Privacy",
    bodyDedupButton: "Body Dedup",
    backButton: "⬅️ Back",
    invalidModeToast: "Invalid mode",
    modeSetToast: (mode: string) => `✅ Mode set to ${mode}`,
    bodyDedupToast: (on: boolean) => `Body dedup ${on ? "enabled" : "disabled"}`,
    privacyToast: (on: boolean) => `Privacy mode ${on ? "enabled" : "disabled"}`,
  },
  allowCommand: {
    usage: `Usage:
  /allow add <alias_or_address> <email_or_domain>
  /allow remove <alias_or_address> <email_or_domain>
  /allow list <alias_or_address>

Examples:
  /allow add alerts-ab12cd@example.com github.com
  /allow add alerts-ab12cd user@example.com
  /allow list alerts-ab12cd`,
    aliasNotFound: (alias: string) => `❌ Alias <code>${alias}</code> not found.`,
    listEmpty: (alias: string) =>
      `📋 No allow rules for <code>${alias}</code>.\n\nAll mail is currently rejected.`,
    listHeader: (alias: string, lines: string) =>
      `📋 Allow rules for <code>${alias}</code>:\n\n${lines}`,
    removed: (alias: string, value: string) =>
      `✅ Removed allow rule for <code>${alias}</code>: ${value}`,
    invalidFormat:
      "❌ Invalid format. Use a domain (e.g. <code>github.com</code>) or email (e.g. <code>user@example.com</code>).",
    alreadyExists: (localPart: string, icon: string, value: string) =>
      `ℹ️ Allow rule already exists for <code>${localPart}</code>: ${icon} ${value}`,
    added: (localPart: string, icon: string, value: string) =>
      `✅ Added allow rule for <code>${localPart}</code>: ${icon} ${value}`,
    subscriptionInactive: (localPart: string) =>
      `⛔ <code>${localPart}</code> is not attached to an active hosted account.`,
    limitReached: (localPart: string, used: number | undefined, limit: number) =>
      `📦 Plan limit reached for <code>${localPart}</code>: ${used ?? limit}/${limit} allow rules used. Upgrade to add more.`,
    createUnavailable: "❌ Allow rule creation is not available right now. Please try again later.",
    upgradePlanButton: "⬆️ Upgrade Plan",
    addRulePrompt: (localPart: string) =>
      `📋 Add allow rule for <code>${localPart}</code>\n\nTap a quick pick, or send a domain (e.g. <code>github.com</code>) or email (e.g. <code>user@example.com</code>).`,
    addingToast: "Adding…",
    removedToast: "Rule removed.",
  },
  label: {
    usage: "Usage: /label <alias-name> <text>\n• To clear: /label <alias-name> --clear",
    cleared: (address: string) => `🧹 Label cleared for <code>${address}</code>.`,
    tooLong: "❌ Label too long. Max 64 characters.",
    setSuccess: (label: string, address: string) =>
      `🏷️ Label set: <b>${label}</b> · <code>${address}</code>`,
    prompt: (address: string, currentLabel: string | null) => {
      const current = currentLabel ? `\n\nCurrent label: <b>${currentLabel}</b>` : "";
      return `🏷️ Set label for <code>${address}</code>${current}\n\nSend the new label (max 64 characters), or tap Cancel.`;
    },
    cancelButton: "✖ Cancel",
    clearedToast: "Label cleared.",
    cancelledToast: "Cancelled.",
    emptyInput: "❌ Label cannot be empty. Try again or tap Cancel.",
  },
  portal: {
    selfHosted:
      "ℹ️ Billing is not enabled in self-hosted mode. /portal is only available on the hosted service.",
    forbidden: "❌ Billing management requires an active hosted account.",
    noCustomer:
      "ℹ️ You don't have an active billing account yet.\n\nUse /upgrade to choose a plan and start a subscription.\n\n<b>Choose a plan:</b>",
    text: "<b>🧾 Billing Portal</b>\n\nTap below to manage your subscription, view invoices, or update payment details. This link expires in 5 minutes.",
    openButton: "Open Billing Portal →",
    unavailable: "❌ Unable to open the billing portal. Please try again shortly.",
  },
  upgrade: {
    selfHosted:
      "ℹ️ Billing is not enabled in self-hosted mode. /upgrade is only available on the hosted service.",
    forbidden: "❌ Billing changes require an active hosted account.",
    header: "<b>⬆️ Upgrade your plan</b>\n\nSelect a plan to start your upgrade:",
    invalidPlan: "❌ Invalid plan selection.",
    loadFailed: "❌ Unable to load upgrade options. Please try again shortly.",
    checkoutFailed: "❌ Unable to create checkout session. Please try again shortly.",
    activeSubscriptionConflict:
      "You already have an active subscription. Use /portal to manage it.",
    checkoutText: (label: string) =>
      `<b>⬆️ ${label}</b>\n\nTap the button below to complete your upgrade. This link expires in 30 minutes.`,
    completeButton: "Complete Checkout →",
    planLabels: {
      personal_monthly: "Personal — Monthly",
      personal_yearly: "Personal — Yearly",
      pro_monthly: "Pro — Monthly",
      pro_yearly: "Pro — Yearly",
      team_monthly: "Team — Monthly",
      team_yearly: "Team — Yearly",
    },
  },
  billingCommands: {
    planSelfHosted:
      "ℹ️ Billing is not enabled in self-hosted mode. /plan is only available on the hosted service.",
    usageSelfHosted:
      "ℹ️ Billing is not enabled in self-hosted mode. /usage is only available on the hosted service.",
    billingSelfHosted:
      "ℹ️ Billing is not enabled in self-hosted mode. /billing is only available on the hosted service.",
    usageUnavailable: "❌ Usage data is temporarily unavailable. Please try again shortly.",
    billingUnavailable: "❌ Billing data is temporarily unavailable. Please try again shortly.",
    upgradeButton: "⬆️ Upgrade",
    manageBillingButton: "🧾 Manage Billing",
    manualBillingAlert: "Self-serve payments are temporarily unavailable.",
    manualBilling: (contact: string) =>
      `ℹ️ Self-serve payments are temporarily unavailable.\n\nHosted upgrades are handled manually for now. Contact ${contact} to upgrade, renew, cancel, or ask billing questions.`,
  },
  donate: {
    title: "☕ Support the project",
    body: "This bot is free to use and maintained as a personal project.\nIf it's useful to you, a small donation keeps the lights on.\n\nDonations are gifts, not payment for service — there are no perks tied to a donation.",
    button: "💛 Donate",
    unavailable: "ℹ️ Donations are not configured on this instance.",
    quotaHint: (url: string) =>
      `\n\n💛 If this bot is useful to you, you can support the project: ${url}`,
  },
  privacy: {
    text: (supportContact: string | null, policyUrl: string | null) =>
      `<b>🔒 Privacy</b>

This bot stores only what's needed to deliver email to your Telegram chats:

• <b>Telegram account:</b> your user id, username, and language code
• <b>Chats:</b> ids and titles where the bot is installed
• <b>Aliases:</b> the email addresses you create and their settings
• <b>Delivery logs:</b> per-email metadata (sender, subject, timestamps, byte counts) for retention/quota enforcement
• <b>Billing records:</b> plan, subscription status, payment references (if applicable)

Email bodies and attachments are stored only as long as your plan's retention allows, then purged.

<b>Your rights</b>
• <b>Access / export:</b> ask the operator using the contact below
• <b>Erasure:</b> run /delete_me to remove your data
• <b>Withdraw consent:</b> stop using the bot and run /delete_me

${policyUrl ? `Full policy: ${policyUrl}\n` : ""}${supportContact ? `Contact: ${supportContact}\n` : ""}
🌐 Also available in Українська, Français, Italiano — use /language to switch.`.trim(),
  },
  deleteMe: {
    prompt: (aliasCount: number, deliveryCount: number, billingCount: number) =>
      `<b>⚠️ Delete all your data?</b>

This will permanently remove:
• ${aliasCount} email alias(es) and their allow rules
• ${deliveryCount} delivery log entry(ies) (incl. stored bodies and attachments)
• ${billingCount} billing record(s)
• Your usage counters, custom domains, and account row

This action <b>cannot be undone</b>. Confirm to proceed.`,
    confirmButton: "🗑 Yes, delete everything",
    cancelButton: "✖ Cancel",
    activeSubscription:
      "⛔ You have an active paid subscription. Cancel it first via /portal, then run /delete_me again.",
    success: "✅ Your data has been deleted. Thanks for using the bot — goodbye 👋",
    cancelled: "Deletion cancelled. Your data is unchanged.",
    failed: "❌ Deletion failed. Please contact the operator.",
    partial:
      "⚠️ Your account and database records were removed, but some stored email files could not be deleted. Please contact the operator to complete the erasure.",
  },
  botCommands: [
    { command: "start", description: "Get started" },
    { command: "newemail", description: "Create a new email alias" },
    { command: "listemail", description: "List your email aliases" },
    { command: "pauseemail", description: "Pause delivery for an alias" },
    { command: "resumeemail", description: "Resume delivery for an alias" },
    { command: "deleteemail", description: "Delete an alias" },
    { command: "allow", description: "Manage allow rules for an alias" },
    { command: "label", description: "Set or clear an alias label" },
    { command: "settings", description: "Per-alias settings" },
    { command: "language", description: "Change bot language" },
    { command: "plan", description: "Show your current plan" },
    { command: "usage", description: "Show this month's usage" },
    { command: "billing", description: "Manage billing" },
    { command: "upgrade", description: "Upgrade plan" },
    { command: "portal", description: "Open Stripe billing portal" },
    { command: "donate", description: "Support the project" },
    { command: "privacy", description: "View privacy policy" },
    { command: "delete_me", description: "Delete all your data" },
    { command: "help", description: "Show help" },
  ],
  usageSummary: {
    planTitle: "<b>📦 Plan</b>",
    name: "Name",
    status: "Status",
    renewsEnds: "Renews/ends",
    limits: "<b>Limits</b>",
    aliases: "Aliases",
    chats: "Chats",
    allowRules: "Allow rules",
    acceptedEmailsMonth: "Accepted emails / month",
    egressMonth: "Egress / month",
    storage: "Storage",
    maxMessageSize: "Max message size",
    retention: "Retention",
    days: "days",
    customDomains: "Custom domains",
    usageTitle: (month: string) => `<b>📊 Usage — ${month}</b>`,
    plan: "Plan",
    inboundThisMonth: "<b>Inbound mail this month</b>",
    acceptedBillable: "Accepted (billable)",
    rejected: "Rejected",
    deliveredTelegram: "Delivered to Telegram",
    telegramFailures: "Telegram delivery failures",
    pendingRetrying: "Pending / retrying",
    billableNote:
      "<i>Note: Telegram delivery failures and pending messages are still counted toward your monthly billable total because the email was accepted into processing.</i>",
    bandwidthStorage: "<b>Bandwidth and storage</b>",
    egress: "Egress",
    account: "<b>Account</b>",
    billingTitle: "<b>💳 Billing</b>",
    accountName: "Account",
    thisMonth: (month: string) => `<b>This month — ${month}</b>`,
  },
} as const;
