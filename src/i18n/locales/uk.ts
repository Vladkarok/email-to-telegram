export const uk = {
  localeName: "Українська",
  language: {
    choose: "<b>Мова</b>\n\nОберіть мову повідомлень бота.",
    current: (name: string) => `Поточна мова: <b>${name}</b>`,
    saved: (name: string) => `Мову змінено на ${name}.`,
    unavailable: "Вибір мови тимчасово недоступний, поки очікується міграція бази даних.",
    buttonEnglish: "English",
    buttonUkrainian: "Українська",
    buttonFrench: "Français",
    buttonItalian: "Italiano",
    closeButton: "✖ Закрити",
    invalidLanguage: "Невідома мова.",
  },
  common: {
    accessDenied: "⛔ Доступ заборонено.",
    tooManyRequests: "⚠️ Забагато запитів. Будь ласка, повільніше.",
    hostedWorkspaceInactive: "⛔ Цей hosted-воркспейс зараз не готовий до створення аліасів.",
    aliasCreationUnavailable: "❌ Створення аліаса зараз недоступне. Спробуйте пізніше.",
    noHostedWorkspace:
      "❌ Для вашого акаунта не знайдено hosted-воркспейс. Використайте /start, щоб створити його.",
    aliasNotFound: "❌ Аліас не знайдено.",
    aliasNotFoundShort: "Аліас не знайдено.",
    chatNotFoundShort: "Чат не знайдено.",
    ruleNotFoundShort: "Правило не знайдено.",
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
    plaintextGuidance: "Plaintext: надсилає буквальний текст без змін.",
    htmlGuidance:
      "HTML: використовуйте rich-text панель вашого поштового клієнта. Не вводьте сирі HTML-теги.",
    markdownGuidance:
      "Markdown: вводьте markdown-синтаксис буквально. Не використовуйте rich-text панель.",
    bodyDedupOn:
      "Дедуплікація тіла: увімкнено. Майбутні листи з тим самим тілом можуть бути приглушені для цього аліаса. Дублікати Message-ID все одно блокуються, коли цей заголовок присутній.",
    bodyDedupOff:
      "Дедуплікація тіла: вимкнено. Повторні алерти з тим самим тілом доставляються. Рекомендовано для alarm-аліасів. Дублікати Message-ID все одно блокуються, коли цей заголовок присутній.",
    privacyOn:
      "Privacy mode: увімкнено. Telegram отримує короткий алерт і посилання для перегляду в браузері. Тіло листа не потрапляє в Telegram, а посилання на вкладення генеруються лише після відкриття перегляду в браузері.",
    privacyOff:
      "Privacy mode: вимкнено. Telegram отримує відрендерене тіло листа та будь-яку обробку вкладень, дозволену налаштуваннями аліаса.",
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
    cancelledToast: "Скасовано.",
    invalidAllowFormat:
      "❌ Невірний формат. Введіть домен (наприклад <code>github.com</code>) або email (наприклад <code>user@example.com</code>).",
  },
  listemail: {
    noAliasesForChat: "📭 У цьому чаті немає аліасів.\n\nСтворіть один командою /newemail <name>",
    noAliases: "📭 Аліасів ще немає.\n\nВикористайте /start, щоб створити перший.",
    aliasesForChat: (count: number) => `📬 Аліаси цього чату (${count}):`,
    allAliases: (count: number) => `📬 Усі ваші аліаси (${count}):`,
    manageHint: "<i>Натисніть аліас нижче, щоб керувати ним.</i>",
  },
  aliasMenu: {
    createFirstButton: "📧 Створити перший email",
    emptyHeader: (chatTitle: string) => `📭 <b>${chatTitle}</b>\n\nАліасів ще немає.`,
    listHeader: (chatTitle: string, count: number) =>
      `📬 <b>${chatTitle}</b> — аліасів: ${count}\n\nНатисніть аліас, щоб керувати ним.`,
    statusActive: "активний",
    statusPaused: "призупинений",
    statusDeleted: "видалений",
    allowRulesHeader: "<b>Allow rules:</b>",
    allowRulesEmpty: "⚠️ Немає — уся пошта відхиляється",
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
        `Статус: ${params.statusIcon} ${params.statusText}\n` +
        `Рендер: <code>${params.renderMode}</code>\n` +
        `Privacy mode: <code>${params.privacyOn ? "on" : "off"}</code>\n` +
        `Дедуплікація тіла: <code>${params.bodyDedupOn ? "on" : "off"}</code>\n\n` +
        `<b>Allow rules:</b>\n${params.rulesText}`
      );
    },
    pauseButton: "⏸ Призупинити",
    resumeButton: "▶️ Відновити",
    deleteButton: "🗑 Видалити",
    allowRulesButton: "📋 Allow rules",
    settingsButton: "⚙️ Налаштування",
    editLabelButton: "✏️ Змінити мітку",
    clearLabelButton: "🧹 Прибрати мітку",
    setLabelButton: "🏷️ Додати мітку",
    backButton: "⬅️ Назад",
    deleteConfirmHeader: (address: string) =>
      `⚠️ Видалити цей email-аліас?\n\n📧 <code>${address}</code>\n\nМайбутні листи на цю адресу будуть відхилятися.`,
    deleteConfirmYes: "🗑 Так, видалити",
    deleteConfirmCancel: "⬅️ Залишити аліас",
  },
  allowRulesMenu: {
    addRuleButton: "➕ Додати правило",
    backButton: "⬅️ Назад",
    headerEmpty: (localPart: string) =>
      `📋 <b>${localPart}</b> — Allow Rules\n\n⚠️ Немає правил — уся пошта відхиляється.\n\nДодайте хоча б один домен або email, щоб почати приймати листи.`,
    headerWithRules: (localPart: string, count: number) =>
      `📋 <b>${localPart}</b> — правил: ${count}\n\nНатисніть ❌, щоб видалити правило.`,
  },
  aliasResolver: {
    ambiguous: (input: string) =>
      `❌ Аліас <code>${input}</code> відповідає кільком інбоксам. Використайте повну адресу (name@domain.tld), щоб усунути неоднозначність.`,
    forbidden: "⛔ Доступ заборонено.",
    notFoundDm: (input: string) =>
      `❌ Аліас <code>${input}</code> не знайдено. Список аліасів — /listemail.`,
    notFoundGroup: (input: string) =>
      `❌ Аліас <code>${input}</code> не знайдено в цьому чаті. Список — /listemail.`,
  },
  aliasActions: {
    deleteUsage: "Використання: /deleteemail <alias-name>",
    deleted: (address: string) =>
      `🗑 Аліас <code>${address}</code> видалено. Майбутні листи будуть відхилятися.`,
    pauseUsage: "Використання: /pauseemail <alias-name>",
    alreadyPaused: (address: string) => `⏸ Аліас <code>${address}</code> уже призупинений.`,
    paused: (address: string) =>
      `⏸ Аліас <code>${address}</code> призупинено. Листи відхилятимуться до відновлення.`,
    resumeUsage: "Використання: /resumeemail <alias-name>",
    alreadyActive: (address: string) => `✅ Аліас <code>${address}</code> уже активний.`,
    resumed: (address: string) =>
      `▶️ Аліас <code>${address}</code> відновлено. Листи знову доставлятимуться.`,
    pausedToast: "Призупинено.",
    resumedToast: "Відновлено.",
    deletedToast: "Видалено.",
    keptToast: "Залишено.",
    cancelledToast: "Скасовано.",
  },
  settingsCommand: {
    usage: [
      "Використання: /settings <alias-name> [plaintext|html|markdown]",
      "Використання: /settings <alias-name> dedup <on|off>",
      "Використання: /settings <alias-name> privacy <on|off>",
    ].join("\n"),
    renderModeSet: (address: string, mode: string, guidance: string) =>
      `✅ Режим відображення для <code>${address}</code> встановлено на <b>${mode}</b>.\n${guidance}`,
    bodyDedupSet: (address: string, on: boolean, guidance: string) =>
      `✅ Дедуплікацію тіла для <code>${address}</code> встановлено на <b>${on ? "on" : "off"}</b>.\n${guidance}`,
    privacySet: (address: string, on: boolean, guidance: string) =>
      `✅ Privacy mode для <code>${address}</code> встановлено на <b>${on ? "on" : "off"}</b>.\n${guidance}`,
    header: (address: string) => `⚙️ Налаштування для <code>${address}</code>`,
    renderModeLine: (mode: string) => `Режим відображення: <b>${mode}</b>`,
    privacyLine: (on: boolean) => `Privacy mode: <b>${on ? "on" : "off"}</b>`,
    bodyDedupLine: (on: boolean) => `Дедуплікація тіла: <b>${on ? "on" : "off"}</b>`,
    privacyButton: "Privacy",
    bodyDedupButton: "Дедуп",
    backButton: "⬅️ Назад",
    invalidModeToast: "Невірний режим",
    modeSetToast: (mode: string) => `✅ Режим встановлено: ${mode}`,
    bodyDedupToast: (on: boolean) => `Дедуплікацію тіла ${on ? "увімкнено" : "вимкнено"}`,
    privacyToast: (on: boolean) => `Privacy mode ${on ? "увімкнено" : "вимкнено"}`,
  },
  allowCommand: {
    usage: `Використання:
  /allow add <alias_or_address> <email_or_domain>
  /allow remove <alias_or_address> <email_or_domain>
  /allow list <alias_or_address>

Приклади:
  /allow add alerts-ab12cd@example.com github.com
  /allow add alerts-ab12cd user@example.com
  /allow list alerts-ab12cd`,
    aliasNotFound: (alias: string) => `❌ Аліас <code>${alias}</code> не знайдено.`,
    listEmpty: (alias: string) =>
      `📋 Для <code>${alias}</code> немає allow rules.\n\nЗараз уся пошта відхиляється.`,
    listHeader: (alias: string, lines: string) =>
      `📋 Allow rules для <code>${alias}</code>:\n\n${lines}`,
    removed: (alias: string, value: string) =>
      `✅ Видалено allow rule для <code>${alias}</code>: ${value}`,
    invalidFormat:
      "❌ Невірний формат. Введіть домен (наприклад <code>github.com</code>) або email (наприклад <code>user@example.com</code>).",
    alreadyExists: (localPart: string, icon: string, value: string) =>
      `ℹ️ Allow rule вже існує для <code>${localPart}</code>: ${icon} ${value}`,
    added: (localPart: string, icon: string, value: string) =>
      `✅ Додано allow rule для <code>${localPart}</code>: ${icon} ${value}`,
    subscriptionInactive: (localPart: string) =>
      `⛔ <code>${localPart}</code> не прив'язаний до активного hosted-воркспейсу.`,
    limitReached: (localPart: string, used: number | undefined, limit: number) =>
      `📦 Досягнуто ліміт плану для <code>${localPart}</code>: ${used ?? limit}/${limit} allow rules. Оновіть план, щоб додати більше.`,
    createUnavailable: "❌ Створення allow rules зараз недоступне. Спробуйте пізніше.",
    upgradePlanButton: "⬆️ Оновити план",
    addRulePrompt: (localPart: string) =>
      `📋 Додати allow rule для <code>${localPart}</code>\n\nНатисніть швидкий варіант або надішліть домен (наприклад <code>github.com</code>) чи email (наприклад <code>user@example.com</code>).`,
    addingToast: "Додаю…",
    removedToast: "Правило видалено.",
  },
  label: {
    usage: "Використання: /label <alias-name> <text>\n• Очистити: /label <alias-name> --clear",
    cleared: (address: string) => `🧹 Мітку для <code>${address}</code> прибрано.`,
    tooLong: "❌ Мітка задовга. Максимум 64 символи.",
    setSuccess: (label: string, address: string) =>
      `🏷️ Мітку встановлено: <b>${label}</b> · <code>${address}</code>`,
    prompt: (address: string, currentLabel: string | null) => {
      const current = currentLabel ? `\n\nПоточна мітка: <b>${currentLabel}</b>` : "";
      return `🏷️ Встановити мітку для <code>${address}</code>${current}\n\nНадішліть нову мітку (макс. 64 символи) або натисніть Скасувати.`;
    },
    cancelButton: "✖ Скасувати",
    clearedToast: "Мітку прибрано.",
    cancelledToast: "Скасовано.",
    emptyInput: "❌ Мітка не може бути порожньою. Спробуйте ще раз або натисніть Скасувати.",
  },
  portal: {
    selfHosted:
      "ℹ️ Білінг не увімкнено в self-hosted режимі. /portal доступна лише в hosted-сервісі.",
    forbidden: "❌ Керування білінгом вимагає прав власника або адміністратора воркспейсу.",
    noCustomer:
      "ℹ️ У вас ще немає активного білінгового акаунта.\n\nВикористайте /upgrade, щоб обрати план і почати підписку.\n\n<b>Оберіть план:</b>",
    text: "<b>🧾 Білінг-портал</b>\n\nНатисніть нижче, щоб керувати підпискою, переглянути рахунки або оновити платіжні реквізити. Це посилання діє 5 хвилин.",
    openButton: "Відкрити білінг-портал →",
    unavailable: "❌ Не вдалося відкрити білінг-портал. Спробуйте трохи пізніше.",
  },
  upgrade: {
    selfHosted:
      "ℹ️ Білінг не увімкнено в self-hosted режимі. /upgrade доступна лише в hosted-сервісі.",
    forbidden: "❌ Зміни білінгу вимагають прав власника або адміністратора воркспейсу.",
    header: "<b>⬆️ Оновіть свій план</b>\n\nОберіть план, щоб почати оновлення:",
    invalidPlan: "❌ Невірний вибір плану.",
    loadFailed: "❌ Не вдалося завантажити опції оновлення. Спробуйте трохи пізніше.",
    checkoutFailed: "❌ Не вдалося створити сесію Checkout. Спробуйте трохи пізніше.",
    activeSubscriptionConflict:
      "У вас уже є активна підписка. Використайте /portal, щоб керувати нею.",
    checkoutText: (label: string) =>
      `<b>⬆️ ${label}</b>\n\nНатисніть кнопку нижче, щоб завершити оновлення. Посилання діє 30 хвилин.`,
    completeButton: "Завершити оплату →",
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
  botCommands: [
    { command: "start", description: "Розпочати" },
    { command: "newemail", description: "Створити новий email-аліас" },
    { command: "listemail", description: "Список ваших email-аліасів" },
    { command: "pauseemail", description: "Призупинити доставку аліаса" },
    { command: "resumeemail", description: "Відновити доставку аліаса" },
    { command: "deleteemail", description: "Видалити аліас" },
    { command: "allow", description: "Керувати allow rules для аліаса" },
    { command: "label", description: "Встановити або прибрати мітку" },
    { command: "settings", description: "Налаштування аліаса" },
    { command: "language", description: "Змінити мову бота" },
    { command: "plan", description: "Показати поточний план" },
    { command: "usage", description: "Використання за цей місяць" },
    { command: "billing", description: "Керування білінгом" },
    { command: "upgrade", description: "Оновити план" },
    { command: "portal", description: "Відкрити Stripe billing portal" },
    { command: "help", description: "Показати довідку" },
  ],
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
