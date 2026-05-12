export const uk = {
  localeName: "Українська",
  language: {
    choose: "<b>Мова</b>\n\nОберіть мову повідомлень бота.",
    current: (name: string) => `Поточна мова: <b>${name}</b>`,
    saved: (name: string) => `Мову змінено на ${name}.`,
    unavailable: "Вибір мови тимчасово недоступний, поки очікується міграція бази даних.",
    buttonEnglish: "English",
    buttonUkrainian: "Українська",
  },
  common: {
    accessDenied: "⛔ Доступ заборонено.",
    tooManyRequests: "⚠️ Забагато запитів. Будь ласка, повільніше.",
    hostedWorkspaceInactive: "⛔ Цей hosted-воркспейс зараз не готовий до створення аліасів.",
    aliasCreationUnavailable: "❌ Створення аліаса зараз недоступне. Спробуйте пізніше.",
    noHostedWorkspace:
      "❌ Для вашого акаунта не знайдено hosted-воркспейс. Використайте /start, щоб створити його.",
  },
  start: {
    openDmButton: "💬 Відкрити приватний чат",
    privateChatRedirect: "Керуйте email-аліасами в приватному чаті 👇",
    dmTitle: (name: string) => `🏠 ${name} (приватний чат)`,
  },
  chatMenu: {
    welcomePrefix: "👋 Вітаю! Усі email-аліаси керуються тут.\n\n",
    noChats:
      "Поки немає зареєстрованих чатів.\n\nДодайте мене до групи, щоб керувати email-аліасами для неї, або використовуйте мене тут у приватному чаті.",
    noChatsEdit:
      "Поки немає зареєстрованих чатів.\n\nДодайте мене до групи, щоб керувати email-аліасами для неї.",
    selectChat: "Оберіть чат для керування:",
    planFooter: (planName: string, used: number, limit: number) =>
      `План: ${planName} | використано аліасів ${used}/${limit}`,
    newEmailButton: "📧 Новий email",
    listEmailsButton: "📋 Список email",
    backButton: "⬅️ Назад",
    managing: (chatTitle: string) => `Керування: <b>${chatTitle}</b>`,
  },
  help: {
    billingStripe: `<b>Білінг (лише hosted)</b>
/billing — статус білінгу воркспейсу з кнопками оновлення плану та керування білінгом
/plan — показати поточний план і ліміти
/usage — показати прийняті/доставлені/невдалі/відхилені листи та квоти за місяць
/upgrade — обрати план і отримати посилання Stripe Checkout
/portal — відкрити Stripe billing portal для керування підпискою`,
    billingManual: `<b>План і використання</b>
/billing — план воркспейсу та статус квот
/plan — показати поточний план і ліміти
/usage — показати прийняті/доставлені/невдалі/відхилені листи та квоти за місяць`,
    text: (billingSection: string, settingsHelp: string, safetyNotes: string) => `<b>📖 Довідка</b>

<b>Меню</b>
/start — відкрити меню керування
/language — обрати мову бота

<b>Аліаси</b>
/newemail — створити новий email-аліас
/newemail &lt;alias&gt; — одразу створити аліас із заданою назвою
/listemail — показати всі ваші аліаси
/pauseemail &lt;alias&gt; — призупинити аліас
/resumeemail &lt;alias&gt; — відновити призупинений аліас
/deleteemail &lt;alias&gt; — видалити аліас
/settings &lt;alias&gt; — змінити режим відображення, дедуплікацію тіла або privacy mode

${settingsHelp}

<b>Allow rules</b>
Лише відправники, що збігаються з allow rule, можуть доставляти листи на аліас.
/allow list &lt;alias&gt;
/allow add &lt;alias&gt; &lt;email_or_domain&gt;
/allow remove &lt;alias&gt; &lt;email_or_domain&gt;
${billingSection}
/help — показати це повідомлення

${safetyNotes}

💡 Після створення аліаса додайте хоча б одне allow rule, інакше вся пошта відхилятиметься.`,
  },
  renderGuidance: {
    renderModeHelp: [
      "<b>Режими відображення</b>",
      "plaintext — надсилає буквальний текст без змін",
      "html — використовуйте кнопки форматування Gmail або поштового клієнта, а не сирі <code>&lt;b&gt;</code> теги",
      "markdown — вводьте markdown-синтаксис буквально, не використовуйте rich-text toolbar",
    ].join("\n"),
    bodyDedupHelp: [
      "<b>Дедуплікація тіла</b>",
      "Дублікати Message-ID все одно блокуються, коли цей заголовок присутній",
      "для нових аліасів дедуплікація тіла вимкнена",
      "body dedup off — повторні алерти з тим самим тілом доставляються (рекомендовано для alarm-аліасів)",
      "body dedup on — майбутні листи з тим самим тілом можуть бути приглушені для цього аліаса",
    ].join("\n"),
    privacyModeHelp: [
      "<b>Privacy Mode</b>",
      "privacy off — Telegram отримує відрендерене тіло листа",
      "privacy on — Telegram отримує лише короткий алерт і посилання для перегляду в браузері",
      "відкриття посилання в браузері попросить ще одне підтвердження перед показом тіла листа",
    ].join("\n"),
    safety: [
      "<b>Безпека</b>",
      "Використовуйте це для операційних алертів і зручного форвардингу, не для секретів або регульованих/конфіденційних даних.",
      "Вміст пошти може бути видимий оператору VPS, у бекапах, учасникам Telegram-чату та всім, хто має доступ до бота або цільового чату.",
      "Не покладайтеся на Telegram-форвардинг як на єдиний life-safety або paging канал.",
    ].join("\n"),
  },
  newemail: {
    autoNameButton: "⏭ Автоназва",
    cancelButton: "✖ Скасувати",
    customDomainButton: "✏️ Власний домен…",
    manageAliasButton: "⚙️ Керувати аліасом",
    prompt: (chatTitle: string) =>
      `📧 Створення аліаса для <b>${chatTitle}</b>\n\n` +
      "Надішліть назву аліаса (наприклад <code>alerts</code>) або натисніть Автоназва, щоб використати дружню назву на кшталт <code>inbox</code>.",
    nameTooLong: "❌ Назва задовга. Максимум 32 символи.",
    invalidName:
      "❌ Некоректна назва. Дозволені лише малі латинські літери, цифри, крапки, дефіси та підкреслення.",
    sharedDomainUnavailable: "⛔ Цей hosted-воркспейс зараз не готовий до створення аліасів.",
    uniqueNameFailed: "❌ Не вдалося підібрати унікальну назву аліаса. Спробуйте іншу.",
    created: (fullAddress: string, chatNote: string) =>
      `✅ Email-аліас створено!\n\n📧 <code>${fullAddress}</code>${chatNote}\n\n⚠️ Уся пошта відхилятиметься, доки ви не дозволите хоча б одного відправника.\nНатисніть швидкий варіант або додайте власний домен:`,
    deliveringTo: (chatTitle: string) => `\nДоставка в: <b>${chatTitle}</b>`,
    aliasLimitReached: (used: number | undefined, limit: number) =>
      `📦 Досягнуто ліміт плану: використано аліасів ${used ?? limit}/${limit}. Оновіть план, щоб створити більше аліасів.`,
    upgradePlanButton: "⬆️ Оновити план",
  },
  listemail: {
    noAliasesForChat: "📭 У цьому чаті немає аліасів.\n\nСтворіть один командою /newemail <name>",
    noAliases: "📭 Аліасів ще немає.\n\nВикористайте /start, щоб створити перший.",
    aliasesForChat: (count: number) => `📬 Аліаси цього чату (${count}):`,
    allAliases: (count: number) => `📬 Усі ваші аліаси (${count}):`,
    manageHint: "<i>Натисніть аліас нижче, щоб керувати ним.</i>",
  },
  billingCommands: {
    planSelfHosted:
      "ℹ️ Білінг не увімкнено в self-hosted режимі. /plan доступна лише в hosted-сервісі.",
    usageSelfHosted:
      "ℹ️ Білінг не увімкнено в self-hosted режимі. /usage доступна лише в hosted-сервісі.",
    billingSelfHosted:
      "ℹ️ Білінг не увімкнено в self-hosted режимі. /billing доступна лише в hosted-сервісі.",
    usageUnavailable: "❌ Дані використання тимчасово недоступні. Спробуйте трохи пізніше.",
    billingUnavailable: "❌ Дані білінгу тимчасово недоступні. Спробуйте трохи пізніше.",
    upgradeButton: "⬆️ Оновити",
    manageBillingButton: "🧾 Керувати білінгом",
    manualBilling:
      "ℹ️ Self-serve платежі тимчасово недоступні.\n\nHosted-оновлення зараз обробляються вручну. Зверніться до підтримки, щоб оновити, продовжити, скасувати план або поставити питання щодо білінгу.",
  },
  usageSummary: {
    planTitle: "<b>📦 План</b>",
    name: "Назва",
    status: "Статус",
    renewsEnds: "Поновлення/завершення",
    limits: "<b>Ліміти</b>",
    aliases: "Аліаси",
    chats: "Чати",
    allowRules: "Allow rules",
    acceptedEmailsMonth: "Прийняті листи / місяць",
    egressMonth: "Egress / місяць",
    storage: "Сховище",
    maxMessageSize: "Макс. розмір повідомлення",
    retention: "Зберігання",
    days: "днів",
    customDomains: "Власні домени",
    usageTitle: (month: string) => `<b>📊 Використання — ${month}</b>`,
    plan: "План",
    inboundThisMonth: "<b>Вхідна пошта цього місяця</b>",
    acceptedBillable: "Прийнято (billable)",
    rejected: "Відхилено",
    deliveredTelegram: "Доставлено в Telegram",
    telegramFailures: "Невдалі доставки в Telegram",
    pendingRetrying: "Очікує / retrying",
    billableNote:
      "<i>Примітка: невдалі доставки в Telegram і повідомлення в очікуванні все одно рахуються в місячний billable total, бо email був прийнятий в обробку.</i>",
    bandwidthStorage: "<b>Трафік і сховище</b>",
    egress: "Egress",
    workspace: "<b>Воркспейс</b>",
    billingTitle: "<b>💳 Білінг</b>",
    workspaceName: "Воркспейс",
    thisMonth: (month: string) => `<b>Цей місяць — ${month}</b>`,
  },
} as const;
