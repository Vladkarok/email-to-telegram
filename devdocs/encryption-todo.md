# Encryption TODO

## Context

This service is self-hosted. The server operator currently has full access to all
email content:

- Raw `.eml` files on disk (until TTL cleanup)
- Email metadata in the database (subject, sender, body SHA-256)
- All Telegram messages sent by the bot (via the bot token)

The goal of this work is to make it so that even a compromised server or a
curious operator cannot read the plaintext content of users' emails.

---

## 1. Attachment encryption at rest

**What:** Encrypt each attachment file before writing to `attachmentDir`.

**How:**

- Generate a random 32-byte AES-256-GCM key per file at write time
- Store the encrypted blob at `storagePath` (replace `writeAttachment()` in `storage/disk.ts`)
- Store the base64-encoded key alongside the attachment record in the DB (column `encryptionKey`)
- Decrypt on-the-fly in `openAttachmentStream()` before streaming to the download response
- The download token URL already uses HMAC — no changes needed there

**Key management options (pick one):**

- **Simple:** Derive a per-user key from `MASTER_ENCRYPTION_KEY` env var + userId using HKDF
- **Better:** Store per-file random keys encrypted with a KMS-managed key (AWS KMS / Vault)

**Files to change:**

- `src/storage/disk.ts` — `writeAttachment`, `openAttachmentStream`
- `src/db/schema.ts` — add `encryptionKey varchar(64)` to `attachments` table
- `src/db/repos/attachments.ts` — pass key through
- `src/email/pipeline.ts` — pass key from write through to link creation
- `src/http/routes/download.ts` — decrypt stream before sending

---

## 2. Raw email encryption at rest

**What:** Encrypt `.eml` files written to `rawEmailDir`.

**How:**

- Encrypt in `writeRawEmail()` using the same AES-256-GCM scheme
- Store the per-file key in `delivery_logs.raw_email_key` (new column)
- Decrypt in `readRawEmail()` (used by the retry worker)
- The backup script (`backup.sh`) backs up the DB which contains the keys — the
  encrypted blobs on disk are useless without DB access

**Files to change:**

- `src/storage/disk.ts` — `writeRawEmail`, `readRawEmail`
- `src/db/schema.ts` — add `rawEmailKey varchar(64)` to `delivery_logs`
- `src/db/repos/deliveryLogs.ts` — pass key through create/find
- `src/http/routes/raw.ts` — capture key from write, store in delivery log
- `src/email/retry.ts` — pass key to `readRawEmail`

---

## 3. Telegram message content (future / harder)

**What:** Avoid sending plaintext email subject/body to Telegram.

**Problem:** Telegram messages are visible to anyone with the bot token. End-to-end
encryption here would require a client-side Telegram app plugin to decrypt, which
doesn't exist for standard Telegram clients.

**Partial mitigation (no client changes needed):**

- Do NOT include the email subject in the Telegram message if the user opts into
  "privacy mode" (new per-alias setting)
- Instead, send "New email from [sender domain] — tap to view" with a one-time
  download link that shows the decrypted content on a self-hosted web page

**This is a significant UX change** and should be designed separately.

---

## 4. Database metadata encryption (nice-to-have)

**What:** Encrypt `subject`, `headerFrom`, `envelopeFrom` in `delivery_logs`.

**How:** Application-level encryption using a stable per-user key derived from
`MASTER_ENCRYPTION_KEY` + aliasId. Queries that filter on these columns (currently
none in the hot path) would need to decrypt in application code.

---

## Priority order

1. **Attachment encryption** (highest value — attachments can be large binary files)
2. **Raw email encryption** (protects plaintext body during the TTL window)
3. **Telegram privacy mode** (protects subject/preview from bot token holder)
4. **DB metadata encryption** (incremental hardening)

---

## Notes

- AES-256-GCM is the recommended algorithm (authenticated, fast in Node.js via
  `crypto.createCipheriv` / `crypto.createDecipheriv`)
- Use a 12-byte random IV stored prepended to the ciphertext blob
- The `MASTER_ENCRYPTION_KEY` env var should be a 32-byte hex string (64 chars),
  validated in `config.ts` at startup (optional — encryption is opt-in)
- Existing unencrypted files/rows must be handled gracefully during a migration:
  check for the presence of `encryptionKey`; if null, read plaintext (backward compat)
