export const fr = {
  localeName: "Français",
  language: {
    choose: "<b>Langue</b>\n\nChoisissez la langue des messages du bot.",
    current: (name: string) => `Langue actuelle : <b>${name}</b>`,
    saved: (name: string) => `Langue définie sur ${name}.`,
    unavailable:
      "La sélection de la langue est temporairement indisponible en attendant la migration de la base de données.",
    buttonEnglish: "English",
    buttonUkrainian: "Українська",
    buttonFrench: "Français",
    buttonItalian: "Italiano",
    closeButton: "✖ Fermer",
    invalidLanguage: "Langue invalide.",
  },
  common: {
    accessDenied: "⛔ Accès refusé.",
    tooManyRequests: "⚠️ Trop de requêtes. Veuillez ralentir.",
    hostedAccountInactive:
      "⛔ Votre compte hosted n'est pas prêt pour la création d'alias pour le moment.",
    aliasCreationUnavailable:
      "❌ La création d'alias n'est pas disponible pour le moment. Réessayez plus tard.",
    noHostedAccount: "❌ Aucun compte hosted trouvé. Utilisez /start pour le créer.",
    aliasNotFound: "❌ Alias introuvable.",
    aliasNotFoundShort: "Alias introuvable.",
    chatNotFoundShort: "Chat introuvable.",
    ruleNotFoundShort: "Règle introuvable.",
    languageHint:
      "🌐 Également disponible en English, Українська, Italiano — utilisez /language pour changer.",
  },
  start: {
    openDmButton: "💬 Ouvrir le chat privé",
    privateChatRedirect: "Gérez les alias e-mail dans notre chat privé 👇",
    dmTitle: (name: string) => `🏠 ${name} (DM)`,
    privacyDisclaimer:
      "ℹ️ En utilisant ce bot, vous acceptez le traitement de vos données. /privacy — politique, /delete_me — supprimer vos données.",
  },
  chatMenu: {
    welcomePrefix: "👋 Bienvenue ! Tous les alias e-mail se gèrent ici.\n\n",
    noChats:
      "Aucun chat enregistré pour le moment.\n\nAjoutez-moi à un groupe pour gérer ses alias e-mail, ou utilisez-moi ici en DM.",
    noChatsEdit:
      "Aucun chat enregistré pour le moment.\n\nAjoutez-moi à un groupe pour gérer ses alias e-mail.",
    selectChat: "Choisissez un chat à gérer :",
    planFooter: (planName: string, used: number, limit: number) =>
      `Plan : ${planName} | ${used}/${limit} alias utilisés`,
    newEmailButton: "📧 Nouvel e-mail",
    listEmailsButton: "📋 Liste des e-mails",
    backButton: "⬅️ Retour",
    managing: (chatTitle: string) => `Gestion : <b>${chatTitle}</b>`,
  },
  help: {
    billingStripe: `<b>Facturation (hosted uniquement)</b>
/billing — statut de facturation avec boutons Upgrade et Manage Billing
/plan — afficher votre plan actuel et ses limites
/usage — afficher les compteurs acceptés/livrés/échoués/rejetés du mois et les quotas
/upgrade — choisir un plan et obtenir un lien Stripe Checkout
/portal — ouvrir le portail Stripe pour gérer votre abonnement`,
    billingManual: `<b>Plan et usage</b>
/billing — plan et statut des quotas du compte
/plan — afficher votre plan actuel et ses limites
/usage — afficher les compteurs acceptés/livrés/échoués/rejetés du mois et les quotas`,
    text: (billingSection: string, settingsHelp: string, safetyNotes: string) => `<b>📖 Aide</b>

<b>Menu</b>
/start — ouvrir le menu de gestion
/language — choisir la langue du bot

<b>Alias</b>
/newemail — créer un nouvel alias e-mail
/newemail &lt;alias&gt; — en créer un immédiatement avec un nom donné
/listemail — lister tous vos alias
/pauseemail &lt;alias&gt; — mettre un alias en pause
/resumeemail &lt;alias&gt; — reprendre un alias en pause
/deleteemail &lt;alias&gt; — supprimer un alias
/settings &lt;alias&gt; — changer le mode de rendu, la déduplication ou le mode privé

${settingsHelp}

<b>Allow rules</b>
Seuls les expéditeurs correspondant à une allow rule peuvent envoyer du courrier à un alias.
/allow list &lt;alias&gt;
/allow add &lt;alias&gt; &lt;email_or_domain&gt;
/allow remove &lt;alias&gt; &lt;email_or_domain&gt;
${billingSection}
<b>Confidentialité &amp; données</b>
/privacy — afficher les informations de confidentialité
/export_me — exporter vos données (RGPD)
/delete_me — supprimer votre compte et vos données

/donate — soutenir le projet
/help — afficher ce message

${safetyNotes}

💡 Après avoir créé un alias, ajoutez au moins une allow rule — sinon tout le courrier est rejeté.`,
  },
  renderGuidance: {
    plaintextGuidance: "Plaintext : envoie le texte littéral tel que tapé.",
    htmlGuidance:
      "HTML : utilisez la barre d'outils de mise en forme de votre client mail. N'écrivez pas de balises HTML brutes.",
    markdownGuidance:
      "Markdown : tapez la syntaxe markdown littéralement. N'utilisez pas la barre d'outils de mise en forme.",
    bodyDedupOn:
      "Body dedup : activé. Les e-mails futurs avec le même corps peuvent être supprimés pour cet alias. Les doublons Message-ID restent bloqués si l'en-tête est présent.",
    bodyDedupOff:
      "Body dedup : désactivé. Les alertes répétées avec le même corps sont délivrées. Recommandé pour les alias d'alarme. Les doublons Message-ID restent bloqués si l'en-tête est présent.",
    privacyOn:
      "Privacy mode : activé. Telegram reçoit une alerte minimale et un lien d'aperçu navigateur. Le corps de l'e-mail reste hors de Telegram, et les téléchargements de pièces jointes sont générés uniquement après ouverture de l'aperçu.",
    privacyOff:
      "Privacy mode : désactivé. Telegram reçoit le corps de l'e-mail rendu et la gestion des pièces jointes autorisée par les paramètres de l'alias.",
    renderModeHelp: [
      "<b>Modes de rendu</b>",
      "plaintext — envoie le texte littéral tel que tapé",
      "html — utilisez les boutons de mise en forme de Gmail ou de votre client mail, pas de balises <code>&lt;b&gt;</code> brutes",
      "markdown — tapez la syntaxe markdown littéralement, pas la barre rich-text",
    ].join("\n"),
    bodyDedupHelp: [
      "<b>Body Dedup</b>",
      "Les doublons Message-ID restent bloqués si l'en-tête est présent",
      "les nouveaux alias ont la déduplication désactivée par défaut",
      "body dedup off — les alertes répétées avec le même corps sont délivrées (recommandé pour les alias d'alarme)",
      "body dedup on — les e-mails futurs avec le même corps peuvent être supprimés pour cet alias",
    ].join("\n"),
    privacyModeHelp: [
      "<b>Privacy Mode</b>",
      "privacy off — Telegram reçoit le corps de l'e-mail rendu",
      "privacy on — Telegram reçoit uniquement une alerte minimale et un lien d'aperçu navigateur",
      "ouvrir le lien dans le navigateur demande une confirmation supplémentaire avant d'afficher le corps de l'e-mail",
    ].join("\n"),
    safety: [
      "<b>Notes de sécurité</b>",
      "Utilisez ceci pour des alertes opérationnelles et du transfert pratique, pas pour des secrets ni des données réglementées/confidentielles.",
      "Le contenu du courrier peut être visible par l'opérateur du VPS, dans les sauvegardes, par les membres du chat Telegram et par toute personne ayant accès au bot ou au chat de destination.",
      "Ne dépendez pas du transfert Telegram comme unique canal life-safety ou de paging.",
    ].join("\n"),
  },
  newemail: {
    autoNameButton: "⏭ Auto-nom",
    cancelButton: "✖ Annuler",
    customDomainButton: "✏️ Domaine personnalisé…",
    manageAliasButton: "⚙️ Gérer l'alias",
    prompt: (chatTitle: string) =>
      `📧 Création d'un alias pour <b>${chatTitle}</b>\n\n` +
      "Envoyez un nom d'alias (ex. <code>alerts</code>), ou tapez Auto-nom pour utiliser un nom convivial comme <code>inbox</code>.",
    nameTooLong: "❌ Nom trop long. Maximum 32 caractères.",
    invalidName:
      "❌ Nom invalide. Seuls les lettres minuscules, chiffres, points, tirets et soulignés sont autorisés.",
    sharedDomainUnavailable:
      "⛔ Votre compte hosted n'est pas prêt pour la création d'alias pour le moment.",
    uniqueNameFailed: "❌ Impossible de trouver un nom d'alias unique. Essayez-en un autre.",
    nameTaken: "❌ Ce nom est déjà pris. Essayez-en un autre.",
    nameCooldown:
      "❌ Ce nom a été supprimé récemment par un autre utilisateur et est temporairement indisponible. Réessayez plus tard ou choisissez-en un autre.",
    created: (fullAddress: string, chatNote: string) =>
      `✅ Alias e-mail créé !\n\n📧 <code>${fullAddress}</code>${chatNote}\n\n⚠️ Tout le courrier est rejeté tant que vous n'avez pas autorisé au moins un expéditeur.\nTapez un choix rapide ou ajoutez un domaine personnalisé :`,
    deliveringTo: (chatTitle: string) => `\nLivraison vers : <b>${chatTitle}</b>`,
    aliasLimitReached: (used: number | undefined, limit: number) =>
      `📦 Limite du plan atteinte : ${used ?? limit}/${limit} alias utilisés. Mettez à niveau pour en créer davantage.`,
    upgradePlanButton: "⬆️ Mettre à niveau",
    cancelledToast: "Annulé.",
    invalidAllowFormat:
      "❌ Format invalide. Utilisez un domaine (ex. <code>github.com</code>) ou un e-mail (ex. <code>user@example.com</code>).",
  },
  listemail: {
    noAliasesForChat: "📭 Aucun alias pour ce chat.\n\nCréez-en un avec /newemail <name>",
    noAliases: "📭 Aucun alias pour le moment.\n\nUtilisez /start pour en créer un.",
    aliasesForChat: (count: number) => `📬 Alias de ce chat (${count}) :`,
    allAliases: (count: number) => `📬 Tous vos alias (${count}) :`,
    manageHint: "<i>Tapez un alias ci-dessous pour le gérer.</i>",
  },
  aliasMenu: {
    createFirstButton: "📧 Créer le premier e-mail",
    emptyHeader: (chatTitle: string) => `📭 <b>${chatTitle}</b>\n\nAucun alias pour le moment.`,
    listHeader: (chatTitle: string, count: number) =>
      `📬 <b>${chatTitle}</b> — ${count} alias\n\nTapez un alias pour le gérer.`,
    statusActive: "actif",
    statusPaused: "en pause",
    statusDeleted: "supprimé",
    allowRulesHeader: "<b>Allow rules :</b>",
    allowRulesEmpty: "⚠️ Aucune — tout le courrier est rejeté",
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
        `Statut : ${params.statusIcon} ${params.statusText}\n` +
        `Rendu : <code>${params.renderMode}</code>\n` +
        `Privacy mode : <code>${params.privacyOn ? "on" : "off"}</code>\n` +
        `Body dedup : <code>${params.bodyDedupOn ? "on" : "off"}</code>\n\n` +
        `<b>Allow rules :</b>\n${params.rulesText}`
      );
    },
    pauseButton: "⏸ Mettre en pause",
    resumeButton: "▶️ Reprendre",
    deleteButton: "🗑 Supprimer",
    allowRulesButton: "📋 Allow rules",
    settingsButton: "⚙️ Paramètres",
    editLabelButton: "✏️ Modifier l'étiquette",
    clearLabelButton: "🧹 Retirer l'étiquette",
    setLabelButton: "🏷️ Ajouter une étiquette",
    backButton: "⬅️ Retour",
    deleteConfirmHeader: (address: string) =>
      `⚠️ Supprimer cet alias e-mail ?\n\n📧 <code>${address}</code>\n\nLes e-mails futurs vers cette adresse seront rejetés.`,
    deleteConfirmYes: "🗑 Oui, supprimer",
    deleteConfirmCancel: "⬅️ Conserver l'alias",
  },
  allowRulesMenu: {
    addRuleButton: "➕ Ajouter une règle",
    backButton: "⬅️ Retour",
    headerEmpty: (localPart: string) =>
      `📋 <b>${localPart}</b> — Allow Rules\n\n⚠️ Aucune règle — tout le courrier est rejeté.\n\nAjoutez au moins un domaine ou e-mail pour commencer à recevoir du courrier.`,
    headerWithRules: (localPart: string, count: number) =>
      `📋 <b>${localPart}</b> — ${count} allow rule(s)\n\nTapez ❌ pour supprimer une règle.`,
  },
  aliasResolver: {
    ambiguous: (input: string) =>
      `❌ L'alias <code>${input}</code> correspond à plusieurs inbox. Utilisez l'adresse complète (name@domain.tld) pour lever l'ambiguïté.`,
    forbidden: "⛔ Accès refusé.",
    notFoundDm: (input: string) =>
      `❌ Alias <code>${input}</code> introuvable. Voir /listemail pour vos alias.`,
    notFoundGroup: (input: string) =>
      `❌ Alias <code>${input}</code> introuvable dans ce chat. Voir /listemail.`,
  },
  aliasActions: {
    deleteUsage: "Usage : /deleteemail <alias-name>",
    deleted: (address: string) =>
      `🗑 Alias <code>${address}</code> supprimé. Les e-mails futurs seront rejetés.`,
    pauseUsage: "Usage : /pauseemail <alias-name>",
    alreadyPaused: (address: string) => `⏸ L'alias <code>${address}</code> est déjà en pause.`,
    paused: (address: string) =>
      `⏸ Alias <code>${address}</code> mis en pause. Les e-mails seront rejetés jusqu'à reprise.`,
    resumeUsage: "Usage : /resumeemail <alias-name>",
    alreadyActive: (address: string) => `✅ L'alias <code>${address}</code> est déjà actif.`,
    resumed: (address: string) =>
      `▶️ Alias <code>${address}</code> repris. Les e-mails seront à nouveau délivrés.`,
    pausedToast: "En pause.",
    resumedToast: "Repris.",
    deletedToast: "Supprimé.",
    keptToast: "Conservé.",
    cancelledToast: "Annulé.",
  },
  settingsCommand: {
    usage: [
      "Usage : /settings <alias-name> [plaintext|html|markdown]",
      "Usage : /settings <alias-name> dedup <on|off>",
      "Usage : /settings <alias-name> privacy <on|off>",
    ].join("\n"),
    renderModeSet: (address: string, mode: string, guidance: string) =>
      `✅ Mode de rendu pour <code>${address}</code> défini sur <b>${mode}</b>.\n${guidance}`,
    bodyDedupSet: (address: string, on: boolean, guidance: string) =>
      `✅ Body dedup pour <code>${address}</code> défini sur <b>${on ? "on" : "off"}</b>.\n${guidance}`,
    privacySet: (address: string, on: boolean, guidance: string) =>
      `✅ Privacy mode pour <code>${address}</code> défini sur <b>${on ? "on" : "off"}</b>.\n${guidance}`,
    header: (address: string) => `⚙️ Paramètres pour <code>${address}</code>`,
    renderModeLine: (mode: string) => `Mode de rendu : <b>${mode}</b>`,
    privacyLine: (on: boolean) => `Privacy mode : <b>${on ? "on" : "off"}</b>`,
    bodyDedupLine: (on: boolean) => `Body dedup : <b>${on ? "on" : "off"}</b>`,
    privacyButton: "Privacy",
    bodyDedupButton: "Dedup",
    backButton: "⬅️ Retour",
    invalidModeToast: "Mode invalide",
    modeSetToast: (mode: string) => `✅ Mode défini : ${mode}`,
    bodyDedupToast: (on: boolean) => `Body dedup ${on ? "activé" : "désactivé"}`,
    privacyToast: (on: boolean) => `Privacy mode ${on ? "activé" : "désactivé"}`,
  },
  allowCommand: {
    usage: `Usage :
  /allow add <alias_or_address> <email_or_domain>
  /allow remove <alias_or_address> <email_or_domain>
  /allow list <alias_or_address>

Exemples :
  /allow add alerts-ab12cd@example.com github.com
  /allow add alerts-ab12cd user@example.com
  /allow list alerts-ab12cd`,
    aliasNotFound: (alias: string) => `❌ Alias <code>${alias}</code> introuvable.`,
    listEmpty: (alias: string) =>
      `📋 Aucune allow rule pour <code>${alias}</code>.\n\nTout le courrier est actuellement rejeté.`,
    listHeader: (alias: string, lines: string) =>
      `📋 Allow rules pour <code>${alias}</code> :\n\n${lines}`,
    removed: (alias: string, value: string) =>
      `✅ Allow rule retirée pour <code>${alias}</code> : ${value}`,
    invalidFormat:
      "❌ Format invalide. Utilisez un domaine (ex. <code>github.com</code>) ou un e-mail (ex. <code>user@example.com</code>).",
    alreadyExists: (localPart: string, icon: string, value: string) =>
      `ℹ️ L'allow rule existe déjà pour <code>${localPart}</code> : ${icon} ${value}`,
    added: (localPart: string, icon: string, value: string) =>
      `✅ Allow rule ajoutée pour <code>${localPart}</code> : ${icon} ${value}`,
    subscriptionInactive: (localPart: string) =>
      `⛔ <code>${localPart}</code> n'est pas attaché à un compte hosted actif.`,
    limitReached: (localPart: string, used: number | undefined, limit: number) =>
      `📦 Limite du plan atteinte pour <code>${localPart}</code> : ${used ?? limit}/${limit} allow rules utilisées. Mettez à niveau pour en ajouter davantage.`,
    createUnavailable:
      "❌ La création d'allow rules n'est pas disponible pour le moment. Réessayez plus tard.",
    upgradePlanButton: "⬆️ Mettre à niveau",
    addRulePrompt: (localPart: string) =>
      `📋 Ajouter une allow rule pour <code>${localPart}</code>\n\nTapez un choix rapide, ou envoyez un domaine (ex. <code>github.com</code>) ou e-mail (ex. <code>user@example.com</code>).`,
    addingToast: "Ajout en cours…",
    removedToast: "Règle retirée.",
  },
  label: {
    usage: "Usage : /label <alias-name> <text>\n• Pour effacer : /label <alias-name> --clear",
    cleared: (address: string) => `🧹 Étiquette retirée pour <code>${address}</code>.`,
    tooLong: "❌ Étiquette trop longue. Maximum 64 caractères.",
    setSuccess: (label: string, address: string) =>
      `🏷️ Étiquette définie : <b>${label}</b> · <code>${address}</code>`,
    prompt: (address: string, currentLabel: string | null) => {
      const current = currentLabel ? `\n\nÉtiquette actuelle : <b>${currentLabel}</b>` : "";
      return `🏷️ Définir une étiquette pour <code>${address}</code>${current}\n\nEnvoyez la nouvelle étiquette (max. 64 caractères), ou tapez Annuler.`;
    },
    cancelButton: "✖ Annuler",
    clearedToast: "Étiquette retirée.",
    cancelledToast: "Annulé.",
    emptyInput: "❌ L'étiquette ne peut pas être vide. Réessayez ou tapez Annuler.",
  },
  portal: {
    selfHosted:
      "ℹ️ La facturation n'est pas activée en mode self-hosted. /portal n'est disponible que sur le service hosted.",
    forbidden: "❌ La gestion de la facturation requiert un compte hosted actif.",
    noCustomer:
      "ℹ️ Vous n'avez pas encore de compte de facturation actif.\n\nUtilisez /upgrade pour choisir un plan et démarrer un abonnement.\n\n<b>Choisissez un plan :</b>",
    text: "<b>🧾 Portail de facturation</b>\n\nTapez ci-dessous pour gérer votre abonnement, voir les factures ou mettre à jour vos moyens de paiement. Ce lien expire dans 5 minutes.",
    openButton: "Ouvrir le portail →",
    unavailable: "❌ Impossible d'ouvrir le portail de facturation. Réessayez sous peu.",
  },
  upgrade: {
    selfHosted:
      "ℹ️ La facturation n'est pas activée en mode self-hosted. /upgrade n'est disponible que sur le service hosted.",
    forbidden:
      "❌ Les changements de facturation requièrent les droits propriétaire ou administrateur.",
    header: "<b>⬆️ Mettre à niveau votre plan</b>\n\nChoisissez un plan pour démarrer :",
    invalidPlan: "❌ Sélection de plan invalide.",
    loadFailed: "❌ Impossible de charger les options de mise à niveau. Réessayez sous peu.",
    checkoutFailed: "❌ Impossible de créer la session Checkout. Réessayez sous peu.",
    activeSubscriptionConflict:
      "Vous avez déjà un abonnement actif. Utilisez /portal pour le gérer.",
    checkoutText: (label: string) =>
      `<b>⬆️ ${label}</b>\n\nTapez le bouton ci-dessous pour finaliser la mise à niveau. Ce lien expire dans 30 minutes.`,
    completeButton: "Finaliser le paiement →",
    planLabels: {
      personal_monthly: "Personal — Mensuel",
      personal_yearly: "Personal — Annuel",
      pro_monthly: "Pro — Mensuel",
      pro_yearly: "Pro — Annuel",
      team_monthly: "Team — Mensuel",
      team_yearly: "Team — Annuel",
    },
  },
  billingCommands: {
    planSelfHosted:
      "ℹ️ La facturation n'est pas activée en mode self-hosted. /plan n'est disponible que sur le service hosted.",
    usageSelfHosted:
      "ℹ️ La facturation n'est pas activée en mode self-hosted. /usage n'est disponible que sur le service hosted.",
    billingSelfHosted:
      "ℹ️ La facturation n'est pas activée en mode self-hosted. /billing n'est disponible que sur le service hosted.",
    usageUnavailable:
      "❌ Les données d'usage sont temporairement indisponibles. Réessayez sous peu.",
    billingUnavailable:
      "❌ Les données de facturation sont temporairement indisponibles. Réessayez sous peu.",
    upgradeButton: "⬆️ Mettre à niveau",
    manageBillingButton: "🧾 Gérer la facturation",
    manualBillingAlert: "Les paiements self-serve sont temporairement indisponibles.",
    manualBilling: (contact: string) =>
      `ℹ️ Les paiements self-serve sont temporairement indisponibles.\n\nLes mises à niveau hosted sont traitées manuellement pour le moment. Contactez ${contact} pour mettre à niveau, renouveler, annuler ou pour toute question de facturation.`,
  },
  donate: {
    title: "☕ Soutenir le projet",
    body: "Ce bot est gratuit et maintenu comme un projet personnel.\nS'il vous est utile, un petit don aide à garder les lumières allumées.\n\nLes dons sont des cadeaux, pas un paiement pour un service — aucun avantage n'est lié à un don.",
    button: "💛 Faire un don",
    unavailable: "ℹ️ Les dons ne sont pas configurés sur cette instance.",
    quotaHint: (url: string) =>
      `\n\n💛 Si ce bot vous est utile, vous pouvez soutenir le projet : ${url}`,
  },
  privacy: {
    text: (supportContact: string | null, policyUrl: string | null) =>
      `<b>🔒 Confidentialité</b>

Ce bot ne stocke que les données nécessaires pour livrer vos e-mails sur Telegram :

• <b>Compte Telegram :</b> votre id, nom d'utilisateur et code de langue
• <b>Chats :</b> ids et titres des chats où le bot est installé
• <b>Alias :</b> adresses e-mail créées et leurs réglages
• <b>Journaux de livraison :</b> métadonnées des e-mails (expéditeur, sujet, horodatages, taille) pour quotas et rétention
• <b>Facturation :</b> plan, statut d'abonnement, références de paiement (le cas échéant)

Les corps d'e-mails et pièces jointes sont conservés selon la durée de votre plan, puis purgés.

<b>Vos droits</b>
• <b>Accès / export :</b> exécutez /export_me pour télécharger une copie JSON de vos données
• <b>Effacement :</b> exécutez /delete_me
• <b>Retrait du consentement :</b> cessez d'utiliser le bot et exécutez /delete_me

${policyUrl ? `Politique complète : ${policyUrl}\n` : ""}${supportContact ? `Contact : ${supportContact}` : ""}`.trim(),
  },
  deleteMe: {
    prompt: (aliasCount: number, deliveryCount: number, billingCount: number) =>
      `<b>⚠️ Supprimer toutes vos données ?</b>

Ceci supprimera définitivement :
• ${aliasCount} alias e-mail et règles d'autorisation associées
• ${deliveryCount} entrée(s) de journal (incl. corps et pièces jointes stockés)
• ${billingCount} enregistrement(s) de facturation
• Vos compteurs d'usage, domaines personnalisés et compte

Cette action est <b>irréversible</b>. Confirmez pour continuer.`,
    confirmButton: "🗑 Oui, tout supprimer",
    cancelButton: "✖ Annuler",
    activeSubscription:
      "⛔ Vous avez un abonnement payant actif. Annulez-le via /portal, puis relancez /delete_me.",
    success: "✅ Vos données ont été supprimées. Merci d'avoir utilisé le bot — au revoir 👋",
    cancelled: "Suppression annulée. Vos données sont inchangées.",
    failed: "❌ Échec de la suppression. Veuillez contacter l'opérateur.",
    partial:
      "⚠️ Votre compte et vos enregistrements en base ont été supprimés, mais certains fichiers d'e-mail stockés n'ont pas pu être supprimés. Veuillez contacter l'opérateur pour terminer l'effacement.",
  },
  exportMe: {
    preparing: "⏳ Préparation de votre export… un instant.",
    caption:
      "Export de vos données (JSON). Les corps d'e-mails et le contenu des pièces jointes ne sont pas inclus — demandez-les à l'opérateur si besoin.",
    noData: "ℹ️ Rien à exporter — aucun enregistrement n'existe pour votre compte.",
    rateLimited: (retryAfterSeconds: number) =>
      `⏳ Veuillez patienter ${retryAfterSeconds} s avant de demander un nouvel export.`,
    tooLarge:
      "⚠️ Votre export est trop volumineux pour être envoyé via Telegram. Veuillez contacter l'opérateur pour le recevoir autrement.",
    failed: "❌ Échec de l'export. Veuillez réessayer ou contacter l'opérateur.",
  },
  botCommands: [
    { command: "start", description: "Démarrer" },
    { command: "newemail", description: "Créer un nouvel alias e-mail" },
    { command: "listemail", description: "Lister vos alias e-mail" },
    { command: "language", description: "Changer la langue du bot" },
    { command: "usage", description: "Usage de ce mois-ci" },
    { command: "donate", description: "Soutenir le projet" },
    { command: "privacy", description: "Politique de confidentialité" },
    { command: "export_me", description: "Télécharger une copie JSON de vos données" },
    { command: "delete_me", description: "Supprimer toutes vos données" },
    { command: "help", description: "Afficher l'aide" },
  ],
  usageSummary: {
    planTitle: "<b>📦 Plan</b>",
    name: "Nom",
    status: "Statut",
    renewsEnds: "Renouvellement/fin",
    limits: "<b>Limites</b>",
    aliases: "Alias",
    allowRules: "Allow rules",
    acceptedEmailsMonth: "E-mails acceptés / mois",
    egressMonth: "Egress / mois",
    storage: "Stockage",
    maxMessageSize: "Taille max. d'un message",
    retention: "Rétention",
    days: "jours",
    customDomains: "Domaines personnalisés",
    usageTitle: (month: string) => `<b>📊 Usage — ${month}</b>`,
    plan: "Plan",
    inboundThisMonth: "<b>Courrier entrant ce mois-ci</b>",
    acceptedBillable: "Accepté (facturable)",
    rejected: "Rejeté",
    deliveredTelegram: "Livré à Telegram",
    telegramFailures: "Échecs de livraison Telegram",
    pendingRetrying: "En attente / retrying",
    billableNote:
      "<i>Note : les échecs de livraison Telegram et les messages en attente comptent dans votre total facturable mensuel car l'e-mail a été accepté en traitement.</i>",
    bandwidthStorage: "<b>Bande passante et stockage</b>",
    egress: "Egress",
    account: "<b>Compte</b>",
    billingTitle: "<b>💳 Facturation</b>",
    accountName: "Compte",
    thisMonth: (month: string) => `<b>Ce mois-ci — ${month}</b>`,
  },
  quotaNotice: {
    monthlyEmailLimit: (planName: string, limit: number) =>
      `⚠️ <b>Votre boîte a atteint la limite mensuelle du plan ${planName} : ${limit} e-mails.</b>\n` +
      `Les nouveaux e-mails entrants sont renvoyés aux expéditeurs jusqu'à la remise à zéro le 1er du mois.\n` +
      `Utilisez /usage pour consulter ce mois-ci, ou /upgrade pour obtenir des limites plus élevées.`,
    storageLimit: (planName: string) =>
      `⚠️ <b>Votre stockage sur le plan ${planName} est plein.</b>\n` +
      `Les nouveaux e-mails entrants sont renvoyés aux expéditeurs.\n` +
      `Libérez de l'espace en supprimant des e-mails ou pièces jointes stockés, ou utilisez /upgrade pour des limites plus élevées.`,
    subscriptionInactive: () =>
      `⚠️ <b>Votre abonnement est inactif, les e-mails entrants sont donc renvoyés.</b>\n` +
      `Utilisez /billing pour vérifier l'état de votre plan.`,
  },
} as const;
