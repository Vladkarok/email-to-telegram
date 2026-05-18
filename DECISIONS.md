# Decisions log — refactor/drop-orgs

This file tracks pragmatic decisions made while removing the `organization`
tenant concept. Delete or migrate as appropriate after the branch merges.

## Test coverage notes

- `tests/unit/billing/manual.test.ts` was replaced with focused
  `grantManualUserPlan` coverage for user-keyed grants, idempotency,
  payment-reference conflicts, stale-version rollback, and validation.

- `tests/unit/dataLifecycle/{deleteUser,exportUser}.test.ts` were rewritten
  around the simpler user-keyed lifecycle primitives.

## Behavioral changes worth documenting

- **Quota lock:** `withOrganizationQuotaLock` used a hashed-UUID advisory
  lock key. `withUserQuotaLock` uses the bigint user id directly via
  `pg_advisory_xact_lock(userId)`. Native bigint mapping, no hashing.

- **Manual billing:** `manualBillingEvents.organizationId` column dropped.
  `telegram_user_id` is now NOT NULL and the sole tenant key. Existing
  rows without `telegram_user_id` were deleted by the migration (no prod
  data to preserve).

- **Custom inbound domains:** `inbound_domains.user_id` replaces
  `organization_id`. `kind='shared'` rows have NULL user_id; `kind='custom'`
  rows require a non-null user_id (enforced by CHECK constraint).

- **Hosted onboarding:** `ensureUserWithOnboardingLimit` no longer creates
  a personal org; it just upserts the user row. The rate-limit + advisory
  lock semantics are preserved.
