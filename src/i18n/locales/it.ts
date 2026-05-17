export const it = {
  localeName: "Italiano",
  language: {
    choose: "<b>Lingua</b>\n\nScegli la lingua dei messaggi del bot.",
    current: (name: string) => `Lingua attuale: <b>${name}</b>`,
    saved: (name: string) => `Lingua impostata su ${name}.`,
    unavailable:
      "La selezione della lingua è temporaneamente non disponibile in attesa della migrazione del database.",
    buttonEnglish: "English",
    buttonUkrainian: "Українська",
    buttonFrench: "Français",
    buttonItalian: "Italiano",
    closeButton: "✖ Chiudi",
    invalidLanguage: "Lingua non valida.",
  },
  common: {
    accessDenied: "⛔ Accesso negato.",
    tooManyRequests: "⚠️ Troppe richieste. Per favore, rallenta.",
    hostedWorkspaceInactive:
      "⛔ Questo workspace hosted non è pronto per la creazione di alias al momento.",
    aliasCreationUnavailable:
      "❌ La creazione di alias non è disponibile al momento. Riprova più tardi.",
    noHostedWorkspace:
      "❌ Nessun workspace hosted trovato per il tuo account. Usa /start per crearne uno.",
    aliasNotFound: "❌ Alias non trovato.",
    aliasNotFoundShort: "Alias non trovato.",
    chatNotFoundShort: "Chat non trovata.",
    ruleNotFoundShort: "Regola non trovata.",
  },
  start: {
    openDmButton: "💬 Apri chat privata",
    privateChatRedirect: "Gestisci gli alias email nella nostra chat privata 👇",
    dmTitle: (name: string) => `🏠 ${name} (DM)`,
  },
  chatMenu: {
    welcomePrefix: "👋 Benvenuto! Tutti gli alias email si gestiscono qui.\n\n",
    noChats:
      "Nessuna chat registrata al momento.\n\nAggiungimi a un gruppo per gestire gli alias email, o usami qui in DM.",
    noChatsEdit:
      "Nessuna chat registrata al momento.\n\nAggiungimi a un gruppo per gestire gli alias email.",
    selectChat: "Scegli una chat da gestire:",
    planFooter: (planName: string, used: number, limit: number) =>
      `Piano: ${planName} | ${used}/${limit} alias usati`,
    newEmailButton: "📧 Nuova email",
    listEmailsButton: "📋 Elenco email",
    backButton: "⬅️ Indietro",
    managing: (chatTitle: string) => `Gestione: <b>${chatTitle}</b>`,
  },
  help: {
    billingStripe: `<b>Fatturazione (solo hosted)</b>
/billing — stato fatturazione del workspace con pulsanti Upgrade e Manage Billing
/plan — mostra il piano attuale e i limiti
/usage — mostra i contatori accettati/consegnati/falliti/rifiutati del mese e le quote
/upgrade — scegli un piano e ottieni un link Stripe Checkout
/portal — apri lo Stripe billing portal per gestire l'abbonamento`,
    billingManual: `<b>Piano e utilizzo</b>
/billing — piano e stato delle quote del workspace
/plan — mostra il piano attuale e i limiti
/usage — mostra i contatori accettati/consegnati/falliti/rifiutati del mese e le quote`,
    text: (billingSection: string, settingsHelp: string, safetyNotes: string) => `<b>📖 Aiuto</b>

<b>Menu</b>
/start — apri il menu di gestione
/language — scegli la lingua del bot

<b>Alias</b>
/newemail — crea un nuovo alias email
/newemail &lt;alias&gt; — creane uno subito con un nome specifico
/listemail — elenca tutti i tuoi alias
/pauseemail &lt;alias&gt; — metti in pausa un alias
/resumeemail &lt;alias&gt; — riprendi un alias in pausa
/deleteemail &lt;alias&gt; — elimina un alias
/settings &lt;alias&gt; — cambia render mode, body dedup o privacy mode

${settingsHelp}

<b>Allow rules</b>
Solo i mittenti corrispondenti a un'allow rule possono consegnare posta a un alias.
/allow list &lt;alias&gt;
/allow add &lt;alias&gt; &lt;email_or_domain&gt;
/allow remove &lt;alias&gt; &lt;email_or_domain&gt;
${billingSection}
/donate — supporta il progetto
/help — mostra questo messaggio

${safetyNotes}

💡 Dopo aver creato un alias, aggiungi almeno un'allow rule — altrimenti tutta la posta viene rifiutata.`,
  },
  renderGuidance: {
    plaintextGuidance: "Plaintext: invia il testo letterale così come digitato.",
    htmlGuidance:
      "HTML: usa la barra di formattazione del tuo client di posta. Non scrivere tag HTML grezzi.",
    markdownGuidance:
      "Markdown: digita la sintassi markdown letteralmente. Non usare la barra rich-text.",
    bodyDedupOn:
      "Body dedup: attivo. Le email future con lo stesso corpo possono essere soppresse per questo alias. I duplicati Message-ID restano bloccati se l'header è presente.",
    bodyDedupOff:
      "Body dedup: disattivo. Le notifiche ripetute con lo stesso corpo vengono comunque consegnate. Consigliato per alias di allarme. I duplicati Message-ID restano bloccati se l'header è presente.",
    privacyOn:
      "Privacy mode: attivo. Telegram riceve un avviso minimo e un link di anteprima nel browser. Il corpo dell'email resta fuori da Telegram, e i download degli allegati vengono generati solo dopo l'apertura dell'anteprima nel browser.",
    privacyOff:
      "Privacy mode: disattivo. Telegram riceve il corpo dell'email renderizzato e la gestione degli allegati consentita dalle impostazioni dell'alias.",
    renderModeHelp: [
      "<b>Render Mode</b>",
      "plaintext — invia il testo letterale così come digitato",
      "html — usa i pulsanti di formattazione di Gmail o del client di posta, non tag <code>&lt;b&gt;</code> grezzi",
      "markdown — digita la sintassi markdown letteralmente, non usare la barra rich-text",
    ].join("\n"),
    bodyDedupHelp: [
      "<b>Body Dedup</b>",
      "I duplicati Message-ID restano bloccati se l'header è presente",
      "i nuovi alias hanno body dedup disattivo di default",
      "body dedup off — le notifiche ripetute con lo stesso corpo vengono comunque consegnate (consigliato per alias di allarme)",
      "body dedup on — le email future con lo stesso corpo possono essere soppresse per questo alias",
    ].join("\n"),
    privacyModeHelp: [
      "<b>Privacy Mode</b>",
      "privacy off — Telegram riceve il corpo dell'email renderizzato",
      "privacy on — Telegram riceve solo un avviso minimo e un link di anteprima nel browser",
      "aprire il link nel browser chiede un'ulteriore conferma prima di rivelare il corpo dell'email",
    ].join("\n"),
    safety: [
      "<b>Note di sicurezza</b>",
      "Usa questo strumento per avvisi operativi e inoltro pratico, non per segreti o dati regolamentati/riservati.",
      "Il contenuto della posta può essere visibile all'operatore del VPS, nei backup, ai membri della chat Telegram e a chiunque abbia accesso al bot o alla chat di destinazione.",
      "Non affidarti all'inoltro Telegram come unico canale life-safety o di paging.",
    ].join("\n"),
  },
  newemail: {
    autoNameButton: "⏭ Nome automatico",
    cancelButton: "✖ Annulla",
    customDomainButton: "✏️ Dominio personalizzato…",
    manageAliasButton: "⚙️ Gestisci alias",
    prompt: (chatTitle: string) =>
      `📧 Creazione alias per <b>${chatTitle}</b>\n\n` +
      "Invia un nome per l'alias (es. <code>alerts</code>), oppure tocca Nome automatico per usarne uno predefinito come <code>inbox</code>.",
    nameTooLong: "❌ Nome troppo lungo. Massimo 32 caratteri.",
    invalidName:
      "❌ Nome non valido. Sono ammessi solo lettere minuscole, cifre, punti, trattini e underscore.",
    sharedDomainUnavailable:
      "⛔ Questo workspace hosted non è pronto per la creazione di alias al momento.",
    uniqueNameFailed: "❌ Impossibile generare un nome alias univoco. Provane uno diverso.",
    created: (fullAddress: string, chatNote: string) =>
      `✅ Alias email creato!\n\n📧 <code>${fullAddress}</code>${chatNote}\n\n⚠️ Tutta la posta viene rifiutata finché non autorizzi almeno un mittente.\nTocca una scelta rapida o aggiungi un dominio personalizzato:`,
    deliveringTo: (chatTitle: string) => `\nConsegna a: <b>${chatTitle}</b>`,
    aliasLimitReached: (used: number | undefined, limit: number) =>
      `📦 Limite del piano raggiunto: ${used ?? limit}/${limit} alias usati. Effettua l'upgrade per crearne altri.`,
    upgradePlanButton: "⬆️ Effettua upgrade",
    cancelledToast: "Annullato.",
    invalidAllowFormat:
      "❌ Formato non valido. Usa un dominio (es. <code>github.com</code>) o un'email (es. <code>user@example.com</code>).",
  },
  listemail: {
    noAliasesForChat: "📭 Nessun alias per questa chat.\n\nCreane uno con /newemail <name>",
    noAliases: "📭 Nessun alias al momento.\n\nUsa /start per crearne uno.",
    aliasesForChat: (count: number) => `📬 Alias di questa chat (${count}):`,
    allAliases: (count: number) => `📬 Tutti i tuoi alias (${count}):`,
    manageHint: "<i>Tocca un alias qui sotto per gestirlo.</i>",
  },
  aliasMenu: {
    createFirstButton: "📧 Crea la prima email",
    emptyHeader: (chatTitle: string) => `📭 <b>${chatTitle}</b>\n\nNessun alias al momento.`,
    listHeader: (chatTitle: string, count: number) =>
      `📬 <b>${chatTitle}</b> — ${count} alias\n\nTocca un alias per gestirlo.`,
    statusActive: "attivo",
    statusPaused: "in pausa",
    statusDeleted: "eliminato",
    allowRulesHeader: "<b>Allow rules:</b>",
    allowRulesEmpty: "⚠️ Nessuna — tutta la posta è rifiutata",
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
        `Stato: ${params.statusIcon} ${params.statusText}\n` +
        `Render: <code>${params.renderMode}</code>\n` +
        `Privacy mode: <code>${params.privacyOn ? "on" : "off"}</code>\n` +
        `Body dedup: <code>${params.bodyDedupOn ? "on" : "off"}</code>\n\n` +
        `<b>Allow rules:</b>\n${params.rulesText}`
      );
    },
    pauseButton: "⏸ Metti in pausa",
    resumeButton: "▶️ Riprendi",
    deleteButton: "🗑 Elimina",
    allowRulesButton: "📋 Allow rules",
    settingsButton: "⚙️ Impostazioni",
    editLabelButton: "✏️ Modifica etichetta",
    clearLabelButton: "🧹 Rimuovi etichetta",
    setLabelButton: "🏷️ Aggiungi etichetta",
    backButton: "⬅️ Indietro",
    deleteConfirmHeader: (address: string) =>
      `⚠️ Eliminare questo alias email?\n\n📧 <code>${address}</code>\n\nLe email future inviate a questo indirizzo saranno rifiutate.`,
    deleteConfirmYes: "🗑 Sì, elimina",
    deleteConfirmCancel: "⬅️ Mantieni alias",
  },
  allowRulesMenu: {
    addRuleButton: "➕ Aggiungi regola",
    backButton: "⬅️ Indietro",
    headerEmpty: (localPart: string) =>
      `📋 <b>${localPart}</b> — Allow Rules\n\n⚠️ Nessuna regola — tutta la posta è rifiutata.\n\nAggiungi almeno un dominio o un'email per iniziare a ricevere posta.`,
    headerWithRules: (localPart: string, count: number) =>
      `📋 <b>${localPart}</b> — ${count} allow rule\n\nTocca ❌ per rimuovere una regola.`,
  },
  aliasResolver: {
    ambiguous: (input: string) =>
      `❌ L'alias <code>${input}</code> corrisponde a più di un inbox. Usa l'indirizzo completo (name@domain.tld) per chiarire.`,
    forbidden: "⛔ Accesso negato.",
    notFoundDm: (input: string) =>
      `❌ Alias <code>${input}</code> non trovato. Vedi /listemail per i tuoi alias.`,
    notFoundGroup: (input: string) =>
      `❌ Alias <code>${input}</code> non trovato in questa chat. Vedi /listemail.`,
  },
  aliasActions: {
    deleteUsage: "Uso: /deleteemail <alias-name>",
    deleted: (address: string) =>
      `🗑 Alias <code>${address}</code> eliminato. Le email future saranno rifiutate.`,
    pauseUsage: "Uso: /pauseemail <alias-name>",
    alreadyPaused: (address: string) => `⏸ L'alias <code>${address}</code> è già in pausa.`,
    paused: (address: string) =>
      `⏸ Alias <code>${address}</code> messo in pausa. Le email saranno rifiutate fino alla ripresa.`,
    resumeUsage: "Uso: /resumeemail <alias-name>",
    alreadyActive: (address: string) => `✅ L'alias <code>${address}</code> è già attivo.`,
    resumed: (address: string) =>
      `▶️ Alias <code>${address}</code> ripreso. Le email verranno nuovamente consegnate.`,
    pausedToast: "In pausa.",
    resumedToast: "Ripreso.",
    deletedToast: "Eliminato.",
    keptToast: "Mantenuto.",
    cancelledToast: "Annullato.",
  },
  settingsCommand: {
    usage: [
      "Uso: /settings <alias-name> [plaintext|html|markdown]",
      "Uso: /settings <alias-name> dedup <on|off>",
      "Uso: /settings <alias-name> privacy <on|off>",
    ].join("\n"),
    renderModeSet: (address: string, mode: string, guidance: string) =>
      `✅ Render mode per <code>${address}</code> impostato su <b>${mode}</b>.\n${guidance}`,
    bodyDedupSet: (address: string, on: boolean, guidance: string) =>
      `✅ Body dedup per <code>${address}</code> impostato su <b>${on ? "on" : "off"}</b>.\n${guidance}`,
    privacySet: (address: string, on: boolean, guidance: string) =>
      `✅ Privacy mode per <code>${address}</code> impostato su <b>${on ? "on" : "off"}</b>.\n${guidance}`,
    header: (address: string) => `⚙️ Impostazioni per <code>${address}</code>`,
    renderModeLine: (mode: string) => `Render mode: <b>${mode}</b>`,
    privacyLine: (on: boolean) => `Privacy mode: <b>${on ? "on" : "off"}</b>`,
    bodyDedupLine: (on: boolean) => `Body dedup: <b>${on ? "on" : "off"}</b>`,
    privacyButton: "Privacy",
    bodyDedupButton: "Dedup",
    backButton: "⬅️ Indietro",
    invalidModeToast: "Modalità non valida",
    modeSetToast: (mode: string) => `✅ Modalità impostata: ${mode}`,
    bodyDedupToast: (on: boolean) => `Body dedup ${on ? "attivato" : "disattivato"}`,
    privacyToast: (on: boolean) => `Privacy mode ${on ? "attivato" : "disattivato"}`,
  },
  allowCommand: {
    usage: `Uso:
  /allow add <alias_or_address> <email_or_domain>
  /allow remove <alias_or_address> <email_or_domain>
  /allow list <alias_or_address>

Esempi:
  /allow add alerts-ab12cd@example.com github.com
  /allow add alerts-ab12cd user@example.com
  /allow list alerts-ab12cd`,
    aliasNotFound: (alias: string) => `❌ Alias <code>${alias}</code> non trovato.`,
    listEmpty: (alias: string) =>
      `📋 Nessuna allow rule per <code>${alias}</code>.\n\nTutta la posta è attualmente rifiutata.`,
    listHeader: (alias: string, lines: string) =>
      `📋 Allow rules per <code>${alias}</code>:\n\n${lines}`,
    removed: (alias: string, value: string) =>
      `✅ Allow rule rimossa per <code>${alias}</code>: ${value}`,
    invalidFormat:
      "❌ Formato non valido. Usa un dominio (es. <code>github.com</code>) o un'email (es. <code>user@example.com</code>).",
    alreadyExists: (localPart: string, icon: string, value: string) =>
      `ℹ️ L'allow rule esiste già per <code>${localPart}</code>: ${icon} ${value}`,
    added: (localPart: string, icon: string, value: string) =>
      `✅ Allow rule aggiunta per <code>${localPart}</code>: ${icon} ${value}`,
    subscriptionInactive: (localPart: string) =>
      `⛔ <code>${localPart}</code> non è collegato a un workspace hosted attivo.`,
    limitReached: (localPart: string, used: number | undefined, limit: number) =>
      `📦 Limite del piano raggiunto per <code>${localPart}</code>: ${used ?? limit}/${limit} allow rule usate. Effettua l'upgrade per aggiungerne altre.`,
    createUnavailable:
      "❌ La creazione di allow rule non è disponibile al momento. Riprova più tardi.",
    upgradePlanButton: "⬆️ Effettua upgrade",
    addRulePrompt: (localPart: string) =>
      `📋 Aggiungi allow rule per <code>${localPart}</code>\n\nTocca una scelta rapida, oppure invia un dominio (es. <code>github.com</code>) o un'email (es. <code>user@example.com</code>).`,
    addingToast: "Aggiungo…",
    removedToast: "Regola rimossa.",
  },
  label: {
    usage: "Uso: /label <alias-name> <text>\n• Per rimuovere: /label <alias-name> --clear",
    cleared: (address: string) => `🧹 Etichetta rimossa per <code>${address}</code>.`,
    tooLong: "❌ Etichetta troppo lunga. Massimo 64 caratteri.",
    setSuccess: (label: string, address: string) =>
      `🏷️ Etichetta impostata: <b>${label}</b> · <code>${address}</code>`,
    prompt: (address: string, currentLabel: string | null) => {
      const current = currentLabel ? `\n\nEtichetta attuale: <b>${currentLabel}</b>` : "";
      return `🏷️ Imposta un'etichetta per <code>${address}</code>${current}\n\nInvia la nuova etichetta (max. 64 caratteri), oppure tocca Annulla.`;
    },
    cancelButton: "✖ Annulla",
    clearedToast: "Etichetta rimossa.",
    cancelledToast: "Annullato.",
    emptyInput: "❌ L'etichetta non può essere vuota. Riprova o tocca Annulla.",
  },
  portal: {
    selfHosted:
      "ℹ️ La fatturazione non è abilitata in modalità self-hosted. /portal è disponibile solo sul servizio hosted.",
    forbidden:
      "❌ La gestione della fatturazione richiede i permessi di proprietario o amministratore del workspace.",
    noCustomer:
      "ℹ️ Non hai ancora un account di fatturazione attivo.\n\nUsa /upgrade per scegliere un piano e iniziare un abbonamento.\n\n<b>Scegli un piano:</b>",
    text: "<b>🧾 Portale di fatturazione</b>\n\nTocca qui sotto per gestire l'abbonamento, vedere le fatture o aggiornare i dati di pagamento. Questo link scade tra 5 minuti.",
    openButton: "Apri il portale →",
    unavailable: "❌ Impossibile aprire il portale di fatturazione. Riprova a breve.",
  },
  upgrade: {
    selfHosted:
      "ℹ️ La fatturazione non è abilitata in modalità self-hosted. /upgrade è disponibile solo sul servizio hosted.",
    forbidden:
      "❌ Le modifiche alla fatturazione richiedono i permessi di proprietario o amministratore.",
    header: "<b>⬆️ Effettua l'upgrade del piano</b>\n\nScegli un piano per iniziare:",
    invalidPlan: "❌ Selezione del piano non valida.",
    loadFailed: "❌ Impossibile caricare le opzioni di upgrade. Riprova a breve.",
    checkoutFailed: "❌ Impossibile creare la sessione Checkout. Riprova a breve.",
    activeSubscriptionConflict: "Hai già un abbonamento attivo. Usa /portal per gestirlo.",
    checkoutText: (label: string) =>
      `<b>⬆️ ${label}</b>\n\nTocca il pulsante qui sotto per completare l'upgrade. Questo link scade tra 30 minuti.`,
    completeButton: "Completa il pagamento →",
    planLabels: {
      personal_monthly: "Personal — Mensile",
      personal_yearly: "Personal — Annuale",
      pro_monthly: "Pro — Mensile",
      pro_yearly: "Pro — Annuale",
      team_monthly: "Team — Mensile",
      team_yearly: "Team — Annuale",
    },
  },
  billingCommands: {
    planSelfHosted:
      "ℹ️ La fatturazione non è abilitata in modalità self-hosted. /plan è disponibile solo sul servizio hosted.",
    usageSelfHosted:
      "ℹ️ La fatturazione non è abilitata in modalità self-hosted. /usage è disponibile solo sul servizio hosted.",
    billingSelfHosted:
      "ℹ️ La fatturazione non è abilitata in modalità self-hosted. /billing è disponibile solo sul servizio hosted.",
    usageUnavailable:
      "❌ I dati di utilizzo sono temporaneamente non disponibili. Riprova a breve.",
    billingUnavailable:
      "❌ I dati di fatturazione sono temporaneamente non disponibili. Riprova a breve.",
    upgradeButton: "⬆️ Upgrade",
    manageBillingButton: "🧾 Gestisci fatturazione",
    manualBilling:
      "ℹ️ I pagamenti self-serve sono temporaneamente non disponibili.\n\nGli upgrade hosted sono gestiti manualmente per il momento. Contatta il supporto per fare upgrade, rinnovare, annullare o per domande sulla fatturazione.",
  },
  donate: {
    title: "☕ Supporta il progetto",
    body: "Questo bot è gratuito ed è mantenuto come progetto personale.\nSe ti è utile, una piccola donazione aiuta a tenerlo in vita.\n\nLe donazioni sono regali, non un pagamento per il servizio — non sono legati vantaggi alla donazione.",
    button: "💛 Dona",
    unavailable: "ℹ️ Le donazioni non sono configurate su questa istanza.",
    quotaHint: (url: string) =>
      `\n\n💛 Se questo bot ti è utile, puoi supportare il progetto: ${url}`,
  },
  botCommands: [
    { command: "start", description: "Inizia" },
    { command: "newemail", description: "Crea un nuovo alias email" },
    { command: "listemail", description: "Elenca i tuoi alias email" },
    { command: "pauseemail", description: "Metti in pausa un alias" },
    { command: "resumeemail", description: "Riprendi un alias" },
    { command: "deleteemail", description: "Elimina un alias" },
    { command: "allow", description: "Gestisci le allow rules di un alias" },
    { command: "label", description: "Imposta o rimuovi un'etichetta" },
    { command: "settings", description: "Impostazioni dell'alias" },
    { command: "language", description: "Cambia lingua del bot" },
    { command: "plan", description: "Mostra il tuo piano attuale" },
    { command: "usage", description: "Utilizzo di questo mese" },
    { command: "billing", description: "Gestisci la fatturazione" },
    { command: "upgrade", description: "Aggiorna il piano" },
    { command: "portal", description: "Apri il portale Stripe" },
    { command: "donate", description: "Supporta il progetto" },
    { command: "help", description: "Mostra aiuto" },
  ],
  usageSummary: {
    planTitle: "<b>📦 Piano</b>",
    name: "Nome",
    status: "Stato",
    renewsEnds: "Rinnovo/scadenza",
    limits: "<b>Limiti</b>",
    aliases: "Alias",
    chats: "Chat",
    allowRules: "Allow rules",
    acceptedEmailsMonth: "Email accettate / mese",
    egressMonth: "Egress / mese",
    storage: "Storage",
    maxMessageSize: "Dimensione max. messaggio",
    retention: "Retention",
    days: "giorni",
    customDomains: "Domini personalizzati",
    usageTitle: (month: string) => `<b>📊 Utilizzo — ${month}</b>`,
    plan: "Piano",
    inboundThisMonth: "<b>Posta in entrata questo mese</b>",
    acceptedBillable: "Accettate (fatturabili)",
    rejected: "Rifiutate",
    deliveredTelegram: "Consegnate a Telegram",
    telegramFailures: "Errori di consegna Telegram",
    pendingRetrying: "In attesa / retrying",
    billableNote:
      "<i>Nota: errori di consegna Telegram e messaggi in attesa contano comunque nel totale fatturabile mensile perché l'email è stata accettata in elaborazione.</i>",
    bandwidthStorage: "<b>Banda e storage</b>",
    egress: "Egress",
    workspace: "<b>Workspace</b>",
    billingTitle: "<b>💳 Fatturazione</b>",
    workspaceName: "Workspace",
    thisMonth: (month: string) => `<b>Questo mese — ${month}</b>`,
  },
} as const;
