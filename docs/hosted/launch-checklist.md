# Hosted Public Launch Checklist

Use this before enabling public hosted signup or live Stripe billing.

## Policy And Contacts

- Replace `<abuse@example.com>`, `<support@example.com>`, and
  `<privacy@example.com>` in hosted docs.
- Review and publish public acceptable-use language.
- Review and publish public privacy/data request language.
- Review and publish pricing, cancellation, refund, and tax language.
- Confirm a private support log exists for export, erasure, billing, and abuse
  requests.

## Stripe

- Run [`../monetization/stripe-test-mode-runbook.md`](../monetization/stripe-test-mode-runbook.md)
  in staging.
- Confirm live Stripe products and prices match `src/billing/plans.ts`.
- Confirm live webhook endpoint uses the live `whsec_...` secret.
- Confirm `BILLING_SUCCESS_URL` and `BILLING_CANCEL_URL` point to public hosted
  pages.
- Confirm Stripe Customer Portal is enabled and tested in live mode.
- Confirm refund, cancellation, annual billing, and tax handling are reviewed.

## Abuse And Deliverability

- Run the shared-domain emergency disable procedure in staging.
- Confirm hosted onboarding and alias creation throttles are enabled.
- Confirm inbound sender/domain/local-part block controls are available.
- Confirm egress limits are enforced for attachment downloads and privacy-view
  pages.
- Publish an abuse contact and monitor it during beta.

## Data Lifecycle

- Exercise hosted export in staging:

  ```bash
  APP_MODE=hosted npm start -- --hosted-export-organization <organizationId> --hosted-export-output /secure/support/exports/<organizationId>.json
  ```

- Exercise hosted deletion in staging:

  ```bash
  APP_MODE=hosted npm start -- --hosted-delete-organization <organizationId>
  ```

- Confirm failed file deletes cause non-zero exit and are remediated manually.
- Confirm export delivery uses a private support channel.

## Product Surface

- Confirm `/start`, `/billing`, `/plan`, `/usage`, `/upgrade`, and `/portal`
  work in hosted mode.
- Confirm self-hosted mode does not require Stripe settings.
- Confirm public pricing does not advertise member invites or custom-domain
  self-service before those flows exist.
- Confirm README or website links point to the correct hosted policy pages.

## Final Gate

Do not enable public signup or live billing until:

- CI is green on `main`
- staging manual checkout/cancel/webhook flow passed
- abuse policy and contacts are published
- privacy/data request language is published
- pricing/cancellation/refund/tax language is reviewed
- operator has a rollback path for disabling new hosted onboarding
