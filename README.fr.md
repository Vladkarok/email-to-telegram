# email-to-telegram

Des alias e-mail qui livrent le courrier dans Telegram. Créez une adresse
depuis un bot Telegram, choisissez qui peut y écrire, et lisez les messages
dans une conversation privée, un groupe ou un sujet de forum.

[English](README.md) · [Українська](README.uk.md) · [中文](README.zh-CN.md) ·
Français · [Italiano](README.it.md)

![Démo : créer un alias, envoyer un e-mail, le recevoir dans Telegram](docs/assets/demo.gif)

## Deux façons de l'utiliser

**Le bot hébergé.** Ouvrez [@tgemails_Bot](https://t.me/tgemails_Bot),
envoyez `/start`, puis `/newemail`. L'adresse fonctionne quelques secondes
plus tard. Pas besoin de domaine, de serveur ni de compte Cloudflare. L'offre
gratuite comprend 3 alias et 100 e-mails livrés par mois. S'il vous en faut
plus, écrivez à [@yolovlad](https://t.me/yolovlad). Avant d'en dépendre, lisez
les [règles d'utilisation](https://vladkarok.github.io/email-to-telegram/hosted/acceptable-use/)
et la [politique de confidentialité](https://vladkarok.github.io/email-to-telegram/hosted/privacy-and-data-requests/)
(en anglais).

**Votre propre serveur.** Le code est sous licence MIT. Cloudflare Email
Routing reçoit le courrier de votre domaine, un petit Worker vérifie l'alias,
et une application Node sur votre serveur livre le message dans Telegram. Le
guide de déploiement est en anglais :
[First deployment guide](README.md#first-deployment-guide).

## À quoi ça sert

- les alertes d'applications, de serveurs et de supervision de disponibilité
- les notifications de CI, de déploiement et de GitHub
- les notifications SaaS qui se perdent dans une boîte trop pleine
- les automatisations capables d'envoyer un e-mail, comme un flux Power Automate
- les alertes d'une équipe dans un seul groupe ou sujet Telegram

Le bot fonctionne dans un seul sens, volontairement. Il n'envoie jamais
d'e-mail. Les copies stockées des messages et des pièces jointes expirent
(après 7 jours avec l'offre gratuite), et Telegram conserve les messages livrés.

## Modèle de confiance

N'utilisez pas ce projet comme coffre-fort ni pour transmettre des secrets,
codes de récupération, mots de passe, documents médicaux, juridiques ou
financiers, ou tout autre contenu très confidentiel.

Qui peut voir votre courrier :

- l'opérateur du serveur et toute personne ayant accès à ses sauvegardes
- toute personne ayant accès à la conversation Telegram de destination
- toute personne ayant accès au jeton du bot

Telegram est ici un canal pratique, pas un système d'alerte d'urgence.

## Commandes du bot

| Commande                                   | Rôle                                                    |
| ------------------------------------------ | ------------------------------------------------------- |
| `/start`                                   | Ouvrir le menu de gestion en conversation privée        |
| `/newemail [nom]`                          | Créer un alias pour la conversation ou le sujet actuel  |
| `/listemail`                               | Lister vos alias                                        |
| `/pauseemail <nom>` / `/resumeemail <nom>` | Mettre en pause ou réactiver un alias                   |
| `/deleteemail <nom>`                       | Supprimer un alias                                      |
| `/settings <nom>`                          | Format d'affichage, dédoublonnage, mode confidentialité |
| `/allow add <nom> <e-mail_ou_domaine>`     | Autoriser un expéditeur                                 |
| `/allow list <nom>`                        | Voir les expéditeurs autorisés                          |
| `/usage`                                   | Usage de ce mois-ci et limites                          |
| `/plan`                                    | Offre actuelle et ses limites                           |
| `/language`                                | Changer la langue du bot                                |
| `/help`                                    | Aide                                                    |

## Licence

[MIT](LICENSE)
