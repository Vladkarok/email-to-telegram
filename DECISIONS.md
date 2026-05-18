# Decisions log — refactor/drop-orgs

This file tracks pragmatic decisions made while removing the `organization`
tenant concept. Delete or migrate as appropriate after the branch merges.

## Test coverage gaps (follow-up tickets)

- **`tests/unit/billing/manual.test.ts` deleted.** The original 1717-line
  file tested three functions: `grantManualOrganizationPlan` (gone),
  `addManualOrganizationMember` (gone), and `grantManualUserPlan` (kept).
  The user-plan tests were structurally entangled with the org-creation
  paths and would have required a full rewrite. Recommend writing a fresh,
  targeted `manual.test.ts` covering `grantManualUserPlan` happy path,
  idempotency via `payment_reference`, error codes (`user_not_found`,
  `duplicate_payment_reference`, etc.), and the operator-source audit
  field. ~150-300 LOC of new tests.

- **`tests/unit/dataLifecycle/{deleteUser,exportUser}.test.ts` likely need
  rewrite too.** Current versions were sed-renamed from the org tests but
  the mock query shapes don't match the new `deleteHostedUser` /
  `exportHostedUserData` implementations. Quick to redo from scratch since
  the new functions are simpler.

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
