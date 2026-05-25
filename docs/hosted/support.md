# Support — Common Issues

Five things that commonly go wrong, and how to fix them.

---

## 1. Emails are not arriving

**Most likely cause: no allow rule is set.**

Every new alias starts with an empty allow-rule list, which means all
incoming mail is **rejected by default**. You must add at least one rule
before mail can be delivered.

```
/allow add <alias> <sender@example.com>
/allow add <alias> @example.com      ← whole domain
/allow add <alias> *                 ← accept everything (not recommended)
```

Check what rules are active:

```
/allow list <alias>
```

**Other causes to check:**

- Alias is paused — use `/resumeemail <alias>` to re-enable it.
- You are sending to the wrong address. The alias address is
  `<alias>@<hosted-domain>`, not your personal email. Confirm with
  `/listemail`.
- Monthly quota is exhausted. Check with `/usage` — once the limit
  resets at the start of the next calendar month, delivery resumes.
- The sender's domain has a strict DMARC/DKIM policy and the mail was
  rejected at ingress. Rare, but possible with some automated senders.

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
/allow add <alias> @stripe.com
```

Once an allow rule exists, only matching senders can deliver. All other
mail is rejected silently at ingress (no bounce is sent to the sender).

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
