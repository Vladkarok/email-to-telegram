# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog][kac] and this project
follows [Semantic Versioning][semver] for public releases.

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

## Versioning note

Public versioning starts at `v1.0.0`. The project ran on a private
versioning track (`v1.x` through `v2.5.x`) during pre-public iteration;
those tags do not appear in the public repository's history. The
public `v1.0.0` release corresponds to the internal `v2.5.x` codebase
that has been running in production.

## [Unreleased]

## [1.13.0] — 2026-10-07

Deploys no longer lose what users send the bot while it restarts.

### Changed

- **Messages and button taps sent during a restart are answered after
  it.** The bot used to discard everything Telegram queued while it was
  down. It now handles the queue when it starts, in order, within
  Telegram's 24-hour retention. Text messages older than 10 minutes
  (`STALE_TEXT_UPDATE_MAX_AGE_S`) are skipped and counted; taps,
  membership changes and chat migrations are always handled.
- **Shutdown has one 25-second deadline** and Docker waits 30 seconds
  (`stop_grace_period`). The update in progress and deliveries in flight
  finish first; anything cut at the deadline stays in the delivery log for
  the retry worker. Only one retry run at a time.
- The health check turns healthy only once the bot is polling; the
  healthcheck `start_period` is 60 seconds.
- Migrations run on their own connection with a 5-second lock timeout and
  a 2-minute statement timeout.
- The app runs under Docker's init (`init: true`), so a stop signal during
  startup is no longer ignored.

### Added

- `email_to_telegram_bot_updates_skipped_total{reason}` and a "Stale bot
  updates" panel on the Operations dashboard.

## [1.12.2] — 2026-10-07

Measurement release: the bot behaves exactly as in 1.12.1.

### Added

- **Local rich downgrades by reason.**
  `email_to_telegram_rich_ineligible_total{reason}` counts deliveries sent
  as classic messages because the body hit a rich-message limit (input
  size, text, blocks, table columns, nesting depth) or because the
  delivery header or attachments tipped it over. Counted per acknowledged
  send, not while rich sending is off, not for privacy mode. A new
  Operations panel shows it next to the rich vs classic outcomes, as a
  baseline before any change to how wide tables are rendered.

## [1.12.1] — 2026-10-07

Operations release: production logs, host and database metrics, and safer
deploys. The bot behaves exactly as in 1.12.0.

### Added

- **Production app logs in Loki.** A host agent (`monitoring/agent/`,
  deployed by `deploy-monitoring-agent.yml`) runs Promtail on prod, which
  tails the app container's Docker logs only and pushes them over TLS with
  basic auth to the operator's Loki, kept 7 days. The app's logging gains
  the compose `labels` it filters on and rotates at 10 MB × 3.
- **Host and Postgres metrics** from `node_exporter` and
  `postgres_exporter` on both VMs (TLS and basic auth on the private
  network, a read-only `etg_monitor` role), and the off-site backup's age.
  The Operations dashboard's Host & database and Logs rows now have data.

### Changed

- Host deploys are serialized per VM (queued GitHub jobs, a host lock),
  time-bounded, and staging deploys the image its own run built.
- The hosted privacy page says how long logs are kept and how a formal
  erasure request reaches them.

### Fixed

- Staging Promtail discovered every container and lost whole batches to
  Loki's "at least one label pair is required" error; it now asks Docker
  for the app container only.

## [1.12.0] — 2026-10-07

New aliases explain their own bounces, sender names lose their stray quotes,
and the nightly backup cleans up after itself.

### Added

- **Bounce notice for new aliases.** When mail to an alias that has not
  received anything yet bounces because no allow rule matches the sender,
  the owner gets one private message: which alias, which sender domain,
  and that rules match the address in the email's From line. When that
  domain authenticated the message, the notice has an **Allow
  &lt;domain&gt;** button that adds the rule in one tap (it allows every
  address at the domain and works for 7 days); **📋 Allow Rules** opens the
  rules menu. An alias with no rules gets a notice without a domain. At
  most one notice per alias per 24 hours and three in total, only while
  the alias has no delivery yet and is at most 7 days old (or its owner has
  never had mail accepted). The sender domain is kept with the button for
  7 days, then removed; `/export_me` includes it, `/delete_me` removes it,
  and `/privacy` says so. Migration `0011` adds the `alias_activation`
  table and backfills first deliveries.
- Metrics `email_to_telegram_activation_notices_total{stage,result}` and
  `email_to_telegram_activation_allows_total{result}`, with two panels in
  the Operations dashboard.

### Changed

- **`email_addresses.max_emails_hour` is dropped** (migration `0012`). It
  has not been read since 1.10.0. A rollback to 1.11.0 works as before; a
  rollback to 1.10.0 or older first needs `ALTER TABLE email_addresses ADD
COLUMN max_emails_hour integer NOT NULL DEFAULT 60`.
- CI also runs the real-Postgres test suites (`TEST_DATABASE_URL`).

### Fixed

- The From line showed every sender name in quotes, as in
  `"GitHub" <noreply@github.com>`. Telegram messages and the privacy view
  now show `GitHub <noreply@github.com>`. A name keeps its quotes when it
  contains `<`, `>`, `@`, `,`, `;` or `:`, or a lookalike such as the
  full-width `＠`, so it cannot pass for an address. A name with no address
  keeps them too. A message with an empty From now shows `unknown` instead
  of a blank sender. The stored From and allow rules are unchanged.
- **A display name could pick the domain on the privacy alert's Sender
  line.** The alert took the domain from the first `<…>` in the From text,
  so an encoded display name such as `Support <help@bank.com>` made it say
  `bank.com` for mail from another domain. The Sender line now shows the
  domain of the parsed From address, the one the From line shows. A From
  with no `user@domain` address, such as a bare `bank.com`, shows
  `unknown sender`, as does a malformed address such as
  `a@evil.com@bank.com` or `<a@bank.com;evil.com>`, and a domain with
  zero-width or direction-changing characters. The domain is what the
  From header claims; it does not prove who sent the message. A line break in a name-only From could also
  add a fake line to the alert; the line now goes through the same
  sanitizer as the message header.
- The bounce notice and its replies show the sender domain as code, so
  Telegram does not turn it into a link.
- **`scripts/backup.sh` no longer leaves temp files behind.** A nightly
  `.backup-*.archive-meta` was left on every run, and a run killed by a
  signal could leave a partial plaintext dump and the database credentials
  file in the backups volume. Every exit path, `HUP` included, now removes
  this run's own files (named per run, so a concurrent run's files are
  never touched), and leftovers of killed runs are swept at the start of
  each run.

## [1.11.0] — 2026-10-06

Clearer allow rules for new aliases, a monitoring rework that counts what
matters, and logs that no longer carry message data.

### Added

- **Delivery metrics**: `email_to_telegram_build_info{version}`,
  `email_to_telegram_delivery_latency_seconds{path}` (from receipt to the
  first Telegram message), `email_to_telegram_delivery_backlog{state}` with
  the age of the oldest undelivered mail,
  `email_to_telegram_deliveries_lost_total{stage}` (also counts mail whose
  raw copy expired before delivery), and `users{state="ever_delivered"}`.
- **Grafana**: the Application dashboard becomes **Operations** (is mail
  getting from sender to Telegram, how fast, where is it lost), a new
  **Product** dashboard (30 days, UTC) holds the funnel and daily volumes,
  and every dashboard marks process starts. Hourly and daily panels are real
  buckets, so their totals add up. See `docs/operations/monitoring.md`.

### Changed

- **After `/newemail`** the bot says that a rule matches the address in the
  email's From line, and how to forward from Gmail: allow `google.com` first
  so Gmail's confirmation code arrives. Quick picks are now `google.com`,
  `github.com` and `gmail.com`. The add-rule prompt, the empty rules menu and
  `/help` say the same, in all four languages.
- Preflight mail over the hourly cap is counted as `deferred`, not
  `rejected`, in `email_to_telegram_inbound_preflight_total`.
- Counters for known outcomes start at 0, so dashboards show 0 instead of
  "No data".
- App migration `0010` adds a partial index for the delivery backlog query.
  It applies on startup and is ignored by older images.
- The drizzle schema no longer lists `email_addresses.max_emails_hour`; the
  column stays in the database for one more release so a rollback to 1.10.0
  keeps working.

### Fixed

- **Logs no longer carry message data.** Database errors logged their SQL
  parameters (subject, From, attachment names) and pg row values; they now
  log the SQL text, the error code and object names only. The hosted
  blocklist logs the block's id instead of the blocked address, and the
  bot logs a chat's type instead of its title.
- The hosted support page listed `/allow add <alias> @example.com` and `*`,
  which the bot never accepted, and said rejected mail was dropped silently.

### Security

- Cloudflare Worker dev dependencies: `sharp` 0.35.5 through an npm override
  (librsvg advisory; wrangler still pins 0.35.4).

## [1.10.0] — 2026-10-06

Plan limits move out of the code, the free plan doubles its monthly mail, and
the inbound path stops losing or permanently bouncing mail it should not.

### Added

- **`PLAN_LIMITS`**: a JSON env var that overrides single limits of single
  plans, e.g. `PLAN_LIMITS={"free":{"deliveredEmailsMonth":300}}`. Anything
  not named keeps the code default. Unknown plans or keys and out-of-range
  values stop startup. It takes effect when the container is recreated
  (`docker compose up -d`), not on `docker compose restart`. See
  `.env.example` for keys and bounds.
- `/plan` lists the per-alias hourly cap.

### Changed

- **Free plan: 200 delivered emails a month** (was 100).
- **The per-alias hourly cap is a plan limit**, `aliasEmailsPerHour`
  (default 60 on every plan, so nothing changes by default). Self-hosters:
  the `email_addresses.max_emails_hour` column is no longer read; set
  `PLAN_LIMITS={"free":{"aliasEmailsPerHour":N}}` instead. The column stays
  until a later release.
- **Mail over the hourly cap is deferred, not bounced.** Preflight answers
  429, the Worker turns that into a temporary SMTP failure, and the sending
  server retries once the hour frees a slot. It used to be a permanent 550.
- READMEs and the hosted terms point to `/plan` for current limits instead of
  stating numbers.

### Fixed

- **Mail from a sender the alias does not allow now bounces.** When an alias
  had allow rules and the From matched none of them, the raw upload answered
  202 and dropped the message, so the sender saw success. It now answers 403
  (a 550 bounce), the same as a sender that fails authentication, which also
  stops the response from revealing which domains an alias allows.

## [1.9.0] — 2026-10-06

Every alias now looks the same, and new aliases start with rich rendering.

### Changed

- **One message frame for every alias.** Text-only emails and `plaintext`
  aliases get the same quoted From/To/Subject header, divider and paragraph
  body as HTML mail. `plaintext` still sends the email text literally.
- **`html` is the default render mode** for new aliases. Existing aliases
  keep their setting; switch with `/settings <alias> html|plaintext`.
- `/help` ends with where to report problems: the operator contact and the
  GitHub issues page.

### Removed

- The `markdown` render mode. It had no users; any alias still set to it
  renders as `html`.

## [1.8.0] — 2026-10-06

Rich messages for the mail that actually arrives: links and attachments no
longer force the plain-text layout.

### Added

- **Links in rich messages.** Emails with links, including every Gmail and
  Outlook forward, now keep native tables and headings. Links in the source
  are clickable, bare `https://` and `mailto:` text becomes a link, and
  attachment downloads appear as an "Attachments:" paragraph with the same
  one-time links as before. Verified on staging that Telegram draws no link
  preview for rich messages and never requests a linked URL before a click,
  so one-time attachment links stay unused until you open them.
- **Golden rendering tests** over real, redacted emails (a Veeam Agent
  report and its Gmail forward) and `npm run render:preview -- file.eml` to
  see exactly what Telegram would receive.

### Fixed

- A sender could stall delivery with a URL followed by tens of thousands of
  closing brackets; trimming is now linear.
- Directional-control characters are stripped from attachment filenames so
  an extension cannot be disguised.

## [1.7.0] — 2026-10-06

Rich-message polish and a dependency wave that clears every open
Dependabot alert.

### Changed

- **Tables in rich messages** are drawn with cell borders and compact
  padding, matching the source email instead of a borderless grid.
- **Message header.** From/To/Subject is now a quote block with bold
  labels, separated from the email body by a divider. Header fields are
  capped at 512 characters so a crafted subject cannot overflow the message.
- **Sender authentication.** An aligned DKIM pass now authenticates a From
  domain that publishes no DMARC record; previously a DMARC pass was
  effectively required. A DMARC lookup that fails temporarily still yields
  a temporary failure. With mailauth 7 (RFC 9989 Tree Walk), `adkim=s` is
  enforced and a subdomain with its own DMARC record no longer aligns with
  a parent-domain signature.
- **Node 24.** The Docker image and CI run on Node 24. The supported
  minimum for self-hosters is Node 22.19.
- **Releases.** The release workflow refuses a new tag whose commit does
  not carry the matching `package.json` version. Redeploys of existing tags
  are unaffected.

### Security

- mailauth 4.13 → 7.1 (nodemailer 10.0.14, undici 8.11.2): closes
  GHSA-prgh-xp8r-p3m5, GHSA-g57g-f23g-4646, GHSA-6vj9-mwq6-2f5v,
  GHSA-8vvx-rff5-p5rq and the undici 7.x advisory set.
- fastify 5.12.1 → 5.12.5: GHSA-p68q-wchp-6fh7 (authentication bypass via
  malformed URLs), GHSA-667r-xxjv-c9mm, GHSA-hwr6-493r-vm6h,
  GHSA-9q9j-q6p8-xq58, GHSA-4mh8-r7rc-xpvc.
- fast-uri, fast-copy, brace-expansion and wrangler bumps for the remaining
  alerts.

## [1.6.3] — 2026-09-22

Healthchecks.io fail signal on sustained probe failures; clearer quota
notices and plan commands in donation mode.

## [1.6.2] — 2026-09-12

Uptime alert debounce and log redaction; dependency advisories in the
Cloudflare Worker closed.

## [1.6.1] — 2026-08-15

Telegram rich email rendering: structured HTML emails are delivered as
rich messages with headings, lists and native tables, with a classic text
fallback.

## [1.6.0] — 2026-07-21

Alias chat mobility: aliases are no longer tied for life to the chat they
were created in.

### Added

- **Move an alias to another chat.** From the alias menu, tap
  **📦 Move to another chat** and pick any group, channel, or your own
  private chat with the bot that you administer. The alias address never
  changes — only where its mail arrives. Permissions on both the source and
  the destination are re-checked at the moment you confirm.
- **Forum topics.** Deliver an alias into a specific forum topic: open that
  topic, run `/listemail` there, and tap **📌 Deliver in this topic**. A
  **📤 Deliver in General** button sends it back to the General topic at any
  time.
- **Orphan recovery.** If the bot is removed from a group, that group's
  aliases no longer disappear from every menu. Their creator can now move or
  delete them from a private chat with the bot, freeing the alias name for
  reuse.
- **Close button** on the chat, alias-list, and alias-detail menus, so a
  menu can be dismissed instead of lingering in the conversation.
- A durable, append-only audit record of every move and migration, wired
  into the existing data-export and account-deletion flows.

### Changed

- Each delivery attempt now resolves its destination with a single fresh
  read, so an email's text and its attachments always arrive together in
  the same chat, even if the alias is moved mid-delivery.

### Fixed

- **Group → supergroup upgrades are now invisible.** When Telegram upgrades
  a group to a supergroup (which changes the chat's internal id), aliases
  follow the chat automatically and mail keeps arriving. Previously such
  upgrades silently broke delivery.
- An alias whose chat has become permanently unreachable can no longer get
  stuck in a state where it cannot be managed or removed.

### Notes

- New database migration `0009` adds the move-audit table and an
  alias routing-version column. It applies automatically on startup and is
  inert on the previous release, so rollback is a normal image rollback.

## [1.5.0] — 2026-07-15

### Added

- A weekly reminder while the monthly email quota remains exhausted,
  suppressed in the week of the initial quota notice.
- A hosted-mode warning once per month when accepted mail reaches
  80–99% of the monthly email quota.

### Changed

- Donation-mode `/upgrade` explains how to contact the operator for
  higher limits and presents `/donate` as an optional gift. Other billing
  providers without self-service use operator-managed wording.

### Fixed

- `/usage` now counts rejection events caused by monthly email limits,
  storage limits, or inactive subscriptions across all inbound paths.
- French and Italian Telegram language preferences are saved correctly;
  missing preferences are repaired on the next bot interaction.
- Ukrainian count messages use the correct plural forms.
- Quota counters and notices use the same usage month when processing
  crosses a UTC month boundary.

## [1.4.3] — 2026-07-07

The operator dashboard uses a two-column grid that collapses on narrow
screens, with table overflow fixed and dates and usernames kept on one line.

## [1.4.2] — 2026-07-07

The operator console gains a dark palette, branded navigation, table row
hover states, aligned details, focus rings, and clearer status messages.

## [1.4.1] — 2026-07-07

Quota notices point to `/upgrade`, which offers Stripe checkout or operator
contact depending on the billing mode.

## [1.4.0] — 2026-07-07

### Added

- A localized private Telegram notice to the alias owner when mail is
  rejected for monthly email limits, storage limits, or an inactive
  subscription, sent once per reason per month.

### Fixed

- Permanently failed deliveries refund the monthly email quota charged
  when the email was accepted, including across UTC month boundaries.

### Removed

- Unenforced user and chat limits from plan definitions and the chat
  limit displayed by `/plan`.
- The misleading **Users (allowed)** dashboard panel. The metric remains
  available for self-hosted operators.

## [1.3.0] — 2026-07-06

### Added

- Activation metrics for users with an undeleted alias and users whose
  mail was accepted into processing during the current month.
- Grafana panels for inbound acceptance and rejection reasons, deferred
  and permanently failed deliveries, activation, daily delivery volume,
  growth trends, alias status, and staging error logs.

### Changed

- Both Grafana dashboards default to production. Hourly panels use event
  increases, route latency excludes probes, and idle delivery success
  rates show gaps instead of zero.
- Prometheus retention increases from 15 to 90 days for monthly trends.

## [1.2.1] — 2026-06-20

Inbound uptime checks alert the operator when Worker signature or replay
failures occur with no accepted mail in the last hour. Idle mailboxes and
normal per-message rejections do not trigger the alert.

## [1.2.0] — 2026-06-10

### Changed

- Transient Telegram failures retry until the raw email expires instead
  of exhausting three attempts. The default outage tolerance is 24 hours;
  retries pause while Telegram is unreachable.
- Deleted alias names are immediately reusable by their previous owner;
  other users must wait 24 hours. Deleted alias records are purged after
  seven days once no delivery logs reference them.
- `/usage` includes permanently failed deliveries in its failure count.

### Fixed

- Alias addresses are unique across users, including legacy aliases
  without a domain assignment.
- Choosing an alias name already in use returns a clear reply instead of
  silently failing or changing the requested name.
- Old delivery logs without raw email are purged correctly instead of
  failing every cleanup cycle with a database syntax error.

### Security

- Raw inbound uploads require v2 Worker signatures; deploy the updated
  Cloudflare Worker before upgrading the application.
- Attachment links use hashed-token lookup only. The legacy token column
  is removed, so older application images cannot be used after migration.

## [1.1.0] — 2026-05-26

### Added

- A GitHub Pages landing page for hosted policies and operations docs.
- A README demo showing the email-to-Telegram workflow.

### Changed

- `/help` shows billing commands only when self-service Stripe billing
  is enabled. The Telegram command menu omits commands requiring arguments
  and keeps a shorter list of common commands.
- Hosted pricing describes the free, donation-supported beta and
  operator-arranged higher limits instead of unavailable paid plans.
- Hosted policies highlight `/export_me`, `/delete_me`, and
  `/deleteemail` for self-service data access and deletion, and provide
  the abuse-reporting contact.

### Fixed

- The Cloudflare Worker logs a missing SPF pass instead of rejecting
  mail solely because its headers do not show one.

### Security

- Allow rules require a DKIM/DMARC-aligned message From address; claimed
  and SMTP envelope senders no longer authorize delivery. The
  `/allow add-claimed` command is removed.
- Worker v2 signatures cover routing headers as well as the message
  body, and replayed inbound signatures are rejected.
- New attachment links store hashed tokens. Downloads are served as
  binary attachments and claim the link and reserve quota before opening
  stored files.
- Public onboarding and data-request commands are rate-limited to five
  requests per minute per user.
- Secrets must be at least 32 characters and reject common weak prefixes.
  Encrypted-storage backups require encrypted database archives unless
  plaintext backups are explicitly enabled; production Stripe billing
  rejects test keys.
- Runtime dependency updates fix SQL injection, request-validation
  bypasses, path traversal, HTML sanitization bypasses, and related
  advisories. Vitest is upgraded to address development dependency alerts.

## [1.0.0] — Initial public release

Planned scope for the first public-tagged release:

### Features

- Cloudflare Email Routing inbound layer.
- Cloudflare Worker preflight that validates aliases and streams raw
  MIME to the VPS.
- VPS application that parses mail, stores raw `.eml` files and
  attachments, and delivers to Telegram chats, groups, or forum topics.
- Telegram bot for alias management:
  `/start`, `/newemail`, `/listemail`, `/deleteemail`, `/pauseemail`,
  `/resumeemail`, `/settings`, `/allow add|remove|list`, `/language`,
  `/help`.
- Per-alias allow rules (`email` or `domain` precision).
- Per-alias hourly delivery cap.
- Privacy mode with browser reveal link.
- Attachments with expiring download links.
- Optional local storage encryption for raw email and attachments.
- Health checks, backups, structured Pino logs, deduplication.
- Self-hosted Prometheus + Grafana + Loki monitoring stack
  (`monitoring/`) with bearer-token-authenticated `/metrics`.
- i18n foundation: English and Ukrainian bot messages, `/language`
  selection.
- Hosted-mode flag with planned managed billing (to be implemented).

### Documentation

- Full first-deployment guide in `README.md` (Cloudflare zone, DNS,
  Worker, VPS, Telegram bot, Docker Compose).
- Standalone first-deploy example under `docs/examples/`.
- Operations runbook for the monitoring stack under `docs/operations/`.
- Hosted-service draft policies (acceptable use, pricing direction,
  privacy and data requests) under `docs/hosted/`.
