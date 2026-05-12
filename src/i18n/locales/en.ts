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
  },
  common: {
    accessDenied: "⛔ Access denied.",
    tooManyRequests: "⚠️ Too many requests. Please slow down.",
    hostedWorkspaceInactive: "⛔ This hosted workspace is not ready for alias creation right now.",
    aliasCreationUnavailable:
      "❌ Alias creation is not available right now. Please try again later.",
    noHostedWorkspace: "❌ No hosted workspace found for your account. Use /start to set one up.",
  },
  start: {
    openDmButton: "💬 Open DM",
    privateChatRedirect: "Manage email aliases in our private chat 👇",
    dmTitle: (name: string) => `🏠 ${name} (DM)`,
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
/billing — workspace billing status with Upgrade and Manage Billing buttons
/plan — show your current plan and limits
/usage — show this month's accepted/delivered/failed/rejected counts and quotas
/upgrade — choose a plan and get a Stripe checkout link
/portal — open the Stripe billing portal to manage your subscription`,
    billingManual: `<b>Plan and usage</b>
/billing — workspace plan and quota status
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
/help — show this message

${safetyNotes}

💡 After creating an alias, add at least one allow rule — otherwise all mail is rejected.`,
  },
  renderGuidance: {
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
    sharedDomainUnavailable: "⛔ This hosted workspace is not ready for alias creation right now.",
    uniqueNameFailed: "❌ Could not pick a unique alias name. Try a different one.",
    created: (fullAddress: string, chatNote: string) =>
      `✅ Email alias created!\n\n📧 <code>${fullAddress}</code>${chatNote}\n\n⚠️ All mail is rejected until you allow at least one sender.\nTap a quick pick or add a custom domain:`,
    deliveringTo: (chatTitle: string) => `\nDelivering to: <b>${chatTitle}</b>`,
    aliasLimitReached: (used: number | undefined, limit: number) =>
      `📦 Plan limit reached: ${used ?? limit}/${limit} aliases used. Upgrade to create more aliases.`,
    upgradePlanButton: "⬆️ Upgrade Plan",
  },
  listemail: {
    noAliasesForChat: "📭 No aliases for this chat.\n\nCreate one with /newemail <name>",
    noAliases: "📭 No aliases yet.\n\nUse /start to create one.",
    aliasesForChat: (count: number) => `📬 Aliases for this chat (${count}):`,
    allAliases: (count: number) => `📬 All your aliases (${count}):`,
    manageHint: "<i>Tap an alias below to manage it.</i>",
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
    manualBilling:
      "ℹ️ Self-serve payments are temporarily unavailable.\n\nHosted upgrades are handled manually for now. Contact support to upgrade, renew, cancel, or ask billing questions.",
  },
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
    workspace: "<b>Workspace</b>",
    billingTitle: "<b>💳 Billing</b>",
    workspaceName: "Workspace",
    thisMonth: (month: string) => `<b>This month — ${month}</b>`,
  },
} as const;
