# Support — Common Issues

Five things that commonly go wrong, and how to fix them.

---

## 1. Emails are not arriving

**Most likely cause: no allow rule matches the sender.**

Every new alias starts with no allow rules. Mail from a sender that no rule
allows bounces back to that sender. A rule matches the address in the
email's `From:` line, and the sender's domain must authenticate the message
(DKIM or DMARC).

```
/allow add <alias> noreply@github.com   ← one address
/allow add <alias> github.com           ← every address at that domain
```

A domain rule covers that exact domain only: `github.com` does not cover
`mail.github.com`.

Check what rules are active:

```
/allow list <alias>
```

**Forwarding from Gmail.** Gmail's automatic forwarding keeps the original
sender in the `From:` line, so a `gmail.com` rule does not cover forwarded
mail. A `gmail.com` rule is for mail written from a Gmail account. To set up
forwarding:

1. `/allow add <alias> google.com`. Gmail sends its forwarding confirmation
   code from `forwarding-noreply@google.com`.
2. In Gmail, open Settings → Forwarding and POP/IMAP, add the alias address,
   and enter the code that arrives in Telegram.
3. Add a rule for each sender whose mail you forward, or forward only those
   senders with a Gmail filter.

**Other causes to check:**

- Alias is paused — use `/resumeemail <alias>` to re-enable it.
- You are sending to the wrong address. The alias address is
  `<alias>@<hosted-domain>`, not your personal email. Confirm with
  `/listemail`.
- Monthly quota is exhausted. Check with `/usage` — once the limit
  resets at the start of the next calendar month, delivery resumes.
- The message failed sender authentication (DKIM/DMARC). Allow rules only
  match mail that the sender's domain authenticates. Rare, but possible with
  some automated senders.

---

## 2. The bot is not responding

**In a private chat with the bot:**

- Send `/start`. If there is no reply at all, the bot may be temporarily
  unavailable — try again in a few minutes.
- If you previously blocked the bot in Telegram, unblock it first
  (Telegram → bot profile → Unblock).

**In a group chat:**

- The bot must be a member of the group. Add it with
  `@tgemails_Bot` if it is not already present.
- If the bot is present but not responding to commands, it may be in
  [privacy mode](https://core.telegram.org/bots/features#privacy-mode).
  Either promote it to admin, or send `/start` directly in the group to
  trigger the menu.

---

## 3. Alias creation is rejected

**Name already taken** — alias names are globally unique across all users
on the hosted instance. Try a different name.

**Name reserved or looks like a system mailbox / brand** — names such as
`admin`, `support`, `noreply`, `paypal-alerts`, `google-info` are blocked
to prevent impersonation. Pick a personal or project-specific name like
`newsletters`, `shopping`, or `myproject-ci`.

**Plan limit reached** — free accounts have a cap on the number of active
aliases. Use `/plan` to see your limit and `/listemail` to see how many you
have. Delete unused aliases with `/deleteemail <alias>` to free a slot, or
upgrade your plan.

---

## 4. Attachments are missing or files are not downloading

**File is too large for Telegram.** Telegram limits bot-sent files to
50 MB. Attachments over that size are delivered as a browser-view link
instead (accessible via the "View in browser" button on the Telegram
message). The original file is stored and accessible for the retention
period shown in `/plan`.

**Storage quota exhausted.** Once your storage quota is full, new
attachments cannot be stored and are skipped. Check with `/usage`. Delete
old aliases you no longer need (this also frees their stored attachments),
or upgrade your plan.

**Link has expired.** Attachment download links are time-limited. If a
link has expired, the original stored attachment is still accessible
through the browser-view interface as long as it is within your retention
window.

---

## 5. Receiving unwanted mail / want to restrict senders

**Add an allow rule** to restrict an alias to only the senders you trust:

```
/allow add <alias> noreply@github.com
/allow add <alias> stripe.com
```

Only matching senders can deliver. Other mail bounces back to its sender.

**Pause the alias** to temporarily stop all delivery without losing the
address:

```
/pauseemail <alias>
```

**Delete the alias** if you no longer want it at all. This is permanent:

```
/deleteemail <alias>
```

A deleted alias can be re-created later (if the name is available), but
its mail history and settings are gone.

---

## Still stuck?

Contact support: @yolovlad (Telegram) — include your alias name and a
brief description of the issue.

For data requests (export or deletion), use `/export_me` or `/delete_me`
directly in the bot. No need to contact support for these.
