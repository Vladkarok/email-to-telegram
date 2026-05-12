# Hosted i18n Runbook

## Scope

The i18n foundation adds:

- nullable `users.locale`
- English and Ukrainian bot message catalogs
- `/language` with inline language selection
- Telegram `language_code` capture on first contact

Russian is intentionally not exposed in this slice.

## Rollout

1. Deploy the app image.
2. Run database migrations so `0019_users_locale.sql` adds `users.locale`.
3. Smoke test:
   - `/start`
   - `/language`
   - select English
   - select Ukrainian
   - `/help`
   - `/plan`, `/usage`, and `/billing` on hosted mode

The app keeps core startup and normal command handling working while the
`users.locale` column is absent. The explicit `/language` write reports a
temporary unavailable message until the migration is applied.

## Rollback

1. Revert the i18n code deployment.
2. If a schema rollback is required, run:

   ```sql
   ALTER TABLE "users" DROP COLUMN IF EXISTS "locale";
   ```

The column is nullable and does not gate authorization, billing, delivery, or
alias creation. Dropping it only removes user language preferences.
