# email-to-telegram

Alias email che consegnano la posta su Telegram. Crea un indirizzo da un bot
Telegram, scegli chi può scriverti e leggi i messaggi in una chat privata, in
un gruppo o in un topic del forum.

[English](README.md) · [Українська](README.uk.md) · [中文](README.zh-CN.md) ·
[Français](README.fr.md) · Italiano

![Demo: crea un alias, invia un'email, ricevila su Telegram](docs/assets/demo.gif)

## Due modi per usarlo

**Il bot ospitato.** Apri [@tgemails_Bot](https://t.me/tgemails_Bot), invia
`/start` e poi `/newemail`. Dopo pochi secondi l'indirizzo funziona. Non servono
dominio, server o account Cloudflare. Il piano gratuito include 3 alias e 100
email consegnate al mese. Se ti serve di più, scrivi a
[@yolovlad](https://t.me/yolovlad). Prima di farci affidamento, leggi le
[regole d'uso](https://vladkarok.github.io/email-to-telegram/hosted/acceptable-use/)
e l'[informativa sulla privacy](https://vladkarok.github.io/email-to-telegram/hosted/privacy-and-data-requests/)
(in inglese).

**Il tuo server.** Il codice è rilasciato con licenza MIT. Cloudflare Email
Routing riceve la posta per il tuo dominio, un piccolo Worker controlla
l'alias e un'applicazione Node sul tuo server consegna il messaggio su
Telegram. La guida al deploy è in inglese:
[First deployment guide](README.md#first-deployment-guide).

## A cosa serve

- avvisi da applicazioni, server e monitoraggio della disponibilità
- notifiche di CI, deploy e GitHub
- notifiche SaaS che si perdono in una casella troppo piena
- automazioni che sanno inviare un'email, come un flusso Power Automate
- gli avvisi di un team in un unico gruppo o topic Telegram

Il bot funziona in una sola direzione, per scelta. Non invia mai email. Le
copie salvate di messaggi e allegati scadono (dopo 7 giorni con il piano
gratuito), mentre Telegram conserva i messaggi consegnati.

## Modello di fiducia

Non usare questo progetto come cassaforte né per trasmettere segreti, codici di
recupero, password, documenti medici, legali o finanziari o altri contenuti
molto riservati.

Chi può vedere la tua posta:

- l'operatore del server e chiunque abbia accesso ai suoi backup
- chiunque abbia accesso alla chat Telegram di destinazione
- chiunque abbia accesso al token del bot

Qui Telegram è un canale comodo, non un sistema di allerta per le emergenze.

## Comandi del bot

| Comando                                      | Cosa fa                                            |
| -------------------------------------------- | -------------------------------------------------- |
| `/start`                                     | Apre il menu di gestione nella chat privata        |
| `/newemail [nome]`                           | Crea un alias per la chat o il topic corrente      |
| `/listemail`                                 | Elenca i tuoi alias                                |
| `/pauseemail <nome>` / `/resumeemail <nome>` | Mette in pausa o riattiva un alias                 |
| `/deleteemail <nome>`                        | Elimina un alias                                   |
| `/settings <nome>`                           | Formato, rimozione dei duplicati, modalità privacy |
| `/allow add <nome> <email_o_dominio>`        | Autorizza un mittente                              |
| `/allow list <nome>`                         | Mostra i mittenti autorizzati                      |
| `/usage`                                     | Utilizzo di questo mese e limiti                   |
| `/plan`                                      | Piano attuale e relativi limiti                    |
| `/language`                                  | Cambia la lingua del bot                           |
| `/help`                                      | Aiuto                                              |

## Licenza

[MIT](LICENSE)
