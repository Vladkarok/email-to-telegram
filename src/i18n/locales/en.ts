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
    closeButton: "✖ Close",
    languageHint: "🌐 Also available in Українська, Français, Italiano — use /language to switch.",
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
<b>Privacy &amp; data</b>
/privacy — view privacy info
/export_me — export your data (GDPR)
/delete_me — delete your account and data

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
    chatUnavailable:
      "❌ This chat is currently unavailable — it may have just been upgraded to a supergroup. Please try again in a moment.",
    nameTaken: "❌ That name is already taken. Try a different one.",
    nameCooldown:
      "❌ That name was recently deleted by another user and is cooling down. Try again later or pick a different name.",
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
    orphanHeader: "<b>⚠️ Unreachable chat</b>",
    orphanHint:
      "<i>The bot is no longer in the chat these deliver to. You can move them somewhere else or delete them to free the name.</i>",
    orphanButton: (localPart: string) => `⚠️ ${localPart}`,
    orphanMenuHeader: (address: string) =>
      `⚠️ <code>${address}</code>\n\nIts chat is no longer reachable, so mail cannot be delivered. Move it to another chat, or delete it to free the name.`,
    orphanUnavailable: "This alias is reachable again — open it from the list.",
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
    moveButton: "📦 Move to another chat",
    moveToOwnDm: "👤 My private chat with the bot",
    moveOwnDmTitle: "your private chat",
    movePickerHeader: (address: string) =>
      `📦 Move <code>${address}</code>\n\nPick where its mail should arrive from now on. The address itself does not change.`,
    moveNoTargets: (address: string) =>
      `📦 Move <code>${address}</code>\n\nNo other chats available. Add the bot to a group or channel you administer, then try again.`,
    moveConfirmHeader: (address: string, target: string) =>
      `📦 Move <code>${address}</code> to <b>${target}</b>?\n\nFuture mail arrives there. A forum starts in General; you can send it to a specific topic afterwards.`,
    moveConfirmYes: "📦 Yes, move it",
    moveConfirmCancel: "⬅️ Cancel",
    moveDone: (address: string, target: string) =>
      `✅ <code>${address}</code> now delivers to <b>${target}</b>.`,
    // Shared how-to shown after a move into a supergroup and on the alias
    // detail menu. There is no topic picker (Telegram gives bots no way to
    // list a forum's topics), so the only path is to act from inside the topic.
    topicHowTo: `💡 <b>Forum with topics?</b> Mail arrives in General. To deliver into a specific topic: open that topic, send <code>/listemail</code> there, tap the alias, then tap “📌 Deliver in this topic”.`,
    moveDeniedToast: "⛔ You can no longer manage this alias.",
    moveDenied: (reason: string) => {
      const detail: Record<string, string> = {
        actor_not_admin: "You are not an administrator of that chat.",
        not_admin: "The bot must be an administrator of that channel.",
        cannot_post: "The bot cannot post messages in that channel.",
        not_member: "The bot is not a member of that chat.",
        cannot_send: "The bot is not allowed to send messages there.",
        foreign_dm: "Mail can only be moved to your own private chat.",
        dm_not_here:
          "Open this alias from our private chat first, then move it there — that way I know I can reach you.",
        probe_failed: "That chat could not be checked right now. Try again shortly.",
        chat_migrated:
          "That chat was just upgraded to a supergroup, so its address changed. Open the move menu again to pick it fresh.",
      };
      return `⛔ Move cancelled.\n\n${detail[reason] ?? "That chat cannot receive mail."}`;
    },
    topicButton: "📌 Deliver in this topic",
    topicGeneralButton: "📤 Deliver in General",
    topicSet: "✅ Mail for this alias now arrives in this topic.",
    topicCleared: "✅ Mail for this alias now arrives in General.",
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
    routingChanged:
      "⚠️ This alias changed while you were deciding — it may have been moved to another chat. Nothing was done. Open it again to see its current state.",
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
    manualBillingAlert: "Plans are not sold on this instance — run /upgrade for details.",
    manualBilling: (contact: string) =>
      `ℹ️ Self-serve payments are unavailable on your account.\n\n` +
      `Your plan is managed personally by the operator — contact ${contact} to upgrade, renew, cancel, or ask billing questions.`,
    manualBillingDonation: (contact: string) =>
      `ℹ️ This instance runs on a donation model — subscriptions are not sold here.\n\n` +
      `Need higher limits? Message ${contact} to discuss your use case.\n` +
      `If the bot is useful to you, you can support the project with /donate — donations are gifts, not payment for service.`,
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
• <b>Access / export:</b> run /export_me to download a JSON copy of your data
• <b>Erasure:</b> run /delete_me to remove your data
• <b>Withdraw consent:</b> stop using the bot and run /delete_me

${policyUrl ? `Full policy: ${policyUrl}\n` : ""}${supportContact ? `Contact: ${supportContact}` : ""}`.trim(),
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
  exportMe: {
    preparing: "⏳ Preparing your export… one moment.",
    caption:
      "Your data export (JSON). Raw email bodies and attachment bytes are not included — request them from the operator if you need them.",
    noData: "ℹ️ Nothing to export — there are no records for your account.",
    rateLimited: (retryAfterSeconds: number) =>
      `⏳ Please wait ${retryAfterSeconds}s before requesting another export.`,
    tooLarge:
      "⚠️ Your export is too large to send through Telegram. Please contact the operator to receive it another way.",
    failed: "❌ Export failed. Please try again or contact the operator.",
  },
  botCommands: [
    { command: "start", description: "Get started" },
    { command: "newemail", description: "Create a new email alias" },
    { command: "listemail", description: "List your email aliases" },
    { command: "language", description: "Change bot language" },
    { command: "usage", description: "Show this month's usage" },
    { command: "donate", description: "Support the project" },
    { command: "privacy", description: "View privacy policy" },
    { command: "export_me", description: "Download a JSON copy of your data" },
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
  quotaNotice: {
    monthlyEmailLimit: (planName: string, limit: number) =>
      `⚠️ <b>Your inbox reached the ${planName} plan's monthly limit of ${limit} emails.</b>\n` +
      `New incoming mail is being bounced back to senders until the counter resets on the 1st.\n` +
      `Use /usage to review this month, or /upgrade to get higher limits.`,
    storageLimit: (planName: string) =>
      `⚠️ <b>Your storage on the ${planName} plan is full.</b>\n` +
      `New incoming mail is being bounced back to senders.\n` +
      `Free up space by deleting stored emails or attachments, or /upgrade for higher limits.`,
    subscriptionInactive: () =>
      `⚠️ <b>Your subscription is inactive, so incoming mail is being bounced.</b>\n` +
      `Use /billing to review your plan status.`,
    approachingMonthlyLimit: (planName: string, used: number, limit: number) =>
      `⏳ <b>You've used ${used} of the ${planName} plan's ${limit} monthly emails.</b>\n` +
      `Once the limit is reached, new mail bounces back to senders until the counter resets on the 1st.\n` +
      `Use /usage for details, or /upgrade for higher limits.`,
    monthlyLimitReminder: (rejectedCount: number) =>
      `⚠️ <b>Your inbox is still over its monthly limit — incoming mail was rejected ${rejectedCount} times this month.</b>\n` +
      `Mail keeps bouncing until the counter resets on the 1st.\n` +
      `/upgrade to raise your limits and stop losing mail.`,
  },
} as const;
