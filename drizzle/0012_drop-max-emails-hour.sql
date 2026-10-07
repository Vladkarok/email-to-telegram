-- compat: v1.11.0 no longer uses email_addresses.max_emails_hour
ALTER TABLE "email_addresses" DROP COLUMN "max_emails_hour";