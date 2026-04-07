# Encryption And Privacy Hardening Plan

## Current status

Already implemented on `dev`:

- Attachment encryption at rest with envelope encryption
- Raw-email encryption at rest, including retry and pending-email recovery paths
- Privacy mode with one-time browser view links instead of mirroring bodies into Telegram
- Startup guards for unsupported downgrade / key-id mismatch states
- Backup metadata and restore guidance for encrypted storage

Still remaining:

- Real key rotation and DEK re-wrap support
- Optional KMS/Vault-style wrapping backend
- Metadata encryption for selected DB fields
- Optional backfill of older plaintext attachment/raw-email blobs
- Streaming decryption for encrypted downloads instead of buffering whole files
- Optional separate encryption of backup archives themselves

## Why this exists

This project is intentionally optimized for operational alerts and convenience
forwarding, not for highly confidential mail. Even so, there is still room to
reduce the blast radius of disk theft, backup leaks, and casual operator access.

Today the server can still read:

- Raw `.eml` files on disk until cleanup removes them
- Attachment files on disk
- Delivery metadata in Postgres
- Telegram messages sent by the bot

The biggest remaining gaps are around key management, backup hardening, and
limiting what metadata stays readable in Postgres. This document tracks that
remaining work after the first encryption/privacy rollout.

---

## Threat model

This plan is meant to reduce exposure for:

- Stolen disks or snapshots
- Backup archive leaks
- Casual or limited access by a VPS operator
- Partial compromise where the attacker gets storage or DB access, but not full
  live application control and key material

This plan does **not** fully protect against:

- A full runtime compromise of the VPS while the app can already decrypt data
- Anyone who can read delivered Telegram messages or use the bot token
- A user intentionally forwarding sensitive content into the system

That means encryption at rest is worth doing, but it does not replace the
existing disclaimer. Privacy mode is already implemented and should remain the
recommended choice for aliases that should not mirror plaintext into Telegram.

---

## Corrected key design

The earlier draft suggested storing a random per-file AES key directly in the DB.
That is not strong enough: if an attacker gets both the DB and the encrypted
files, they still get plaintext.

Use **envelope encryption** instead:

- Generate a random 32-byte **data encryption key (DEK)** per object
- Encrypt the object with that DEK using `AES-256-GCM`
- Wrap the DEK with a **key encryption key (KEK)**
- Store only the **wrapped DEK** in the database, never the raw DEK
- On read, unwrap the DEK, decrypt, and discard it from memory as soon as possible

### Key hierarchy

Recommended hierarchy:

1. Object data encrypted with a random DEK
2. DEK wrapped by a KEK
3. KEK provided by one of two backends:
   - `local`: a master key from environment or mounted secret
   - `kms`: an external KMS or Vault transit key

### Why this design

This improves on plaintext storage in a meaningful way:

- Disk theft alone does not reveal mail content
- Backups of encrypted files are safer
- DB dumps without the KEK are not enough to decrypt stored files

With a `local` KEK, this still does **not** protect against full compromise of
the same running host, because the app can decrypt while it is alive. That is an
acceptable limitation for a self-hosted alert-forwarding service, but it should
be stated explicitly.

---

## Crypto choices

- Cipher: `AES-256-GCM`
- DEK size: `32` random bytes
- IV size: `12` random bytes
- Tag size: `16` bytes
- Associated data: bind ciphertext to object identity such as
  `attachment:<attachmentId>` or `raw-email:<deliveryLogId>`
- All comparisons and token checks stay constant-time where applicable

Avoid custom crypto beyond envelope wrapping and object-format framing.

---

## Storage format

Store encrypted file blobs on disk with a simple versioned framing format:

```text
magic[4] | version[1] | iv[12] | ciphertext[...] | tag[16]
```

Suggested values:

- `magic = ETG1`
- `version = 1`

Store the following metadata in the database:

- `encryption_mode`: `none | local-v1 | kms-v1`
- `wrapped_dek`: wrapped DEK as base64 or bytea
- `kek_key_id`: optional external key identifier or local key version
- `encrypted_at`: timestamp

Do **not** store the raw DEK in the DB, in the file header, or alongside the
blob anywhere else.

Use plaintext object size already tracked in DB for response sizing where
possible; do not require reading the entire encrypted file to know download
length.

---

## New encryption abstraction

Add a dedicated module instead of scattering crypto across storage code.

### New module

- `src/security/encryption.ts`

Responsibilities:

- Generate random DEKs
- Encrypt and decrypt streams or buffers with AES-GCM
- Wrap and unwrap DEKs
- Parse and emit the file framing format
- Hide backend differences between `local` and `kms`

### Backend interface

Define a small interface:

```ts
interface KeyProvider {
  mode: "local-v1" | "kms-v1";
  wrapKey(plaintextDek: Buffer): Promise<{ wrappedDek: Buffer; keyId?: string }>;
  unwrapKey(wrappedDek: Buffer, keyId?: string): Promise<Buffer>;
}
```

Implementation options:

- `local-v1`
  - KEK comes from `MASTER_ENCRYPTION_KEY`
  - KEK should be a 32-byte secret loaded from env or a mounted Docker secret
  - Wrap the DEK with a KEK-managed AES key wrap scheme or another AEAD layer
- `kms-v1`
  - DEK wrapping delegated to AWS KMS, Vault transit, or similar
  - Store returned wrapped blob and KMS key identifier

For the first iteration, `local-v1` is the practical path. Keep the interface so
the storage layer does not care whether wrapping is local or external later.

---

## Phase 1: Attachment encryption at rest

Status: implemented

### Goal

Encrypt every newly stored attachment file before writing it to disk, while
keeping downloads backward-compatible for existing plaintext rows.

### Schema changes

Extend `attachments` with:

- `encryptionMode varchar(...) not null default 'none'`
- `wrappedDek text null`
- `kekKeyId varchar(...) null`
- `encryptedAt timestamptz null`

Keep `sizeBytes` as the plaintext size.

### File changes

- `src/db/schema.ts`
- `src/db/repos/attachments.ts`
- `src/storage/disk.ts`
- `src/email/pipeline.ts`
- `src/http/routes/download.ts`
- new `src/security/encryption.ts`

### Write path

1. Generate attachment UUID in application code before insert
2. Use AAD `attachment:<attachmentId>`
3. Encrypt content before writing
4. Persist encrypted blob to `storagePath`
5. Insert attachment row with:
   - `encryptionMode`
   - `wrappedDek`
   - `kekKeyId`
   - `encryptedAt`

### Read path

1. Load attachment row
2. If `encryptionMode = none`, stream plaintext as today
3. Otherwise unwrap DEK, decrypt stream, and send plaintext bytes to client
4. If unwrap or decrypt fails, log the error and return `500`

### Notes

- One-time download link semantics are preserved
- AAD is bound to `attachment:<attachmentId>`
- Current limitation: encrypted attachment downloads still decrypt in memory
  before streaming; that is a remaining improvement item

---

## Phase 2: Raw email encryption at rest

Status: implemented

### Goal

Encrypt raw `.eml` files in `rawEmailDir`, including files used by retry and
pending-email recovery.

### Schema changes

Extend `delivery_logs` with:

- `rawEmailEncryptionMode varchar(...) not null default 'none'`
- `rawEmailWrappedDek text null`
- `rawEmailKekKeyId varchar(...) null`
- `rawEmailEncryptedAt timestamptz null`

### File changes

- `src/storage/disk.ts`
- `src/db/schema.ts`
- `src/db/repos/deliveryLogs.ts`
- `src/http/routes/raw.ts`
- `src/email/retry.ts`
- new `src/security/encryption.ts`

### Write path

1. Generate the storage path as today
2. Encrypt the raw MIME buffer before writing
3. Return crypto metadata from `writeRawEmail()`
4. Store crypto metadata in the delivery log

### Read path

1. Load the delivery log
2. If `rawEmailEncryptionMode = none`, read plaintext as today
3. Otherwise unwrap DEK and decrypt
4. Retry worker and pending-email recovery both use the same read helper

### Important nuance

The raw email is persisted before queueing is fully settled in the inbound route.
That is now handled by carrying encryption metadata through pending spool files
and delivery-log creation so recovery can still read encrypted blobs safely.

---

## Phase 3: Privacy mode for Telegram

Status: implemented

Encryption at rest does not protect data already copied into Telegram.

For this project, privacy mode was the highest-value next step after disk
encryption, and it is now in place.

### Goal

Allow an alias to avoid sending plaintext message content into Telegram.

### Behavior

- New per-alias setting: `privacyMode`
- Instead of forwarding subject/body, send a minimal alert such as:
  `New email from example.com for alerts@example.com`
- Include a short-lived one-time view link
- The link renders decrypted content from the server on demand

### Why it matters

This reduces exposure from:

- Bot token compromise
- Broad access to the target Telegram chat
- Sensitive content being copied into Telegram history

This is a user-visible product change and should be designed separately from the
at-rest encryption primitives.

---

## Phase 4: Metadata encryption

Status: not implemented

This is optional and lower priority.

Candidate fields:

- `subject`
- `headerFrom`
- `envelopeFrom`

Guidance:

- Reuse the same envelope-encryption primitives
- Prefer per-row random DEKs over deterministic field encryption
- Accept that searching/filtering on encrypted columns becomes harder

Do this only after attachment/raw-email encryption and privacy mode are stable.

---

## Configuration

Current implementation:

- `STORAGE_ENCRYPTION_MODE=none|local-v1`
- `MASTER_ENCRYPTION_KEY`
- `MASTER_ENCRYPTION_KEY_ID`

Not implemented yet:

- KMS-backed wrapping config
- automatic key-version rotation workflow

Possible future config fields:

- `ENCRYPTION_BACKEND=none|local|kms`
- `MASTER_ENCRYPTION_KEY_VERSION` for richer rotation bookkeeping
- KMS-specific settings if `kms` is used later

Validation rules:

- `none` is allowed for backward compatibility and local development
- `local` requires a valid 32-byte key
- Production docs should strongly recommend not enabling encrypted-at-rest
  writes without secure secret handling

If `STORAGE_ENCRYPTION_MODE=none`, new rows continue to use plaintext storage.
The current runtime explicitly refuses to boot in unsupported downgrade states
when encrypted data still exists.

---

## Key rotation

Status: not implemented

Plan for rotation from the start.

### Minimum viable rotation support

- Every wrapped DEK stores the KEK version or key ID used to wrap it
- Readers choose the correct unwrap key based on stored metadata
- Writers always use the current KEK version

### Rewrap workflow

Later, add an admin job that:

1. Reads row metadata
2. Unwraps the old wrapped DEK
3. Re-wraps the same DEK with the new KEK
4. Updates only the wrapped key metadata

That avoids rewriting entire large attachment files during KEK rotation.

---

## Migration and rollout

Current rollout status:

- Reader compatibility for mixed plaintext/encrypted datasets: implemented
- Encrypted writes for attachments: implemented
- Encrypted writes for raw email: implemented
- Privacy mode: implemented
- Startup downgrade / key-id safeguards: implemented
- Historical plaintext backfill: not implemented

Roll this out in backward-compatible steps.

### Step 1: Ship readers first

Status: done

- Add new schema columns
- Add decryption-aware read helpers
- If row says `encryptionMode = none`, keep plaintext behavior

### Step 2: Enable encrypted writes for new data

Status: done

- Turn on encrypted writes for attachments first
- Then turn on encrypted raw-email writes

### Step 3: Backfill old data only if worth it

Status: not implemented

Optional migration job:

1. Read plaintext object
2. Encrypt it
3. Write encrypted replacement atomically
4. Update DB metadata

Because this project is mostly for alerts with TTL cleanup, a full backfill may
not be worth the operational risk if old data expires quickly anyway.

### Step 4: Rotate backup expectations

Status: partially implemented

After rollout:

- Ensure backup restore docs mention the KEK dependency
- Treat backups without the KEK as incomplete for recovery
- Consider encrypting backup archives separately as well

The current codebase already documents the KEK dependency and emits backup
metadata files, but it does not encrypt the backup archives themselves.

---

## Testing requirements

Add focused tests before rollout.

### Unit tests

- encrypt/decrypt round-trip for buffers and streams
- DEK wrap/unwrap round-trip
- wrong AAD fails decryption
- wrong KEK fails unwrap
- malformed file header fails safely
- plaintext backward-compat path still works

### Integration tests

- encrypted attachment download works end-to-end
- retry worker can read encrypted raw email
- pending raw-email recovery can read encrypted raw email
- mixed dataset works: old plaintext rows and new encrypted rows together

### Operational tests

- restart app and confirm previously encrypted objects still read correctly
- verify backup/restore with KEK present
- verify restore without KEK fails in an obvious, diagnosable way
- verify legacy path-bound raw-email blobs are documented correctly during restore

---

## Recommended implementation order

1. Add key rotation and DEK re-wrap support
2. Add a KMS/Vault-backed wrapping backend if needed
3. Decide whether historical plaintext backfill is worth the operational risk
4. Add metadata encryption only after the above is stable
5. Replace in-memory encrypted-download buffering with true streaming decryption

---

## Practical recommendation for this project

For `email-to-telegram`, the best next sequence is:

1. Implement key rotation / re-wrap support
2. Decide whether encrypted-download streaming is worth the added complexity
3. Add metadata encryption only if the trust model requires it
4. Consider a KMS backend only if the project grows beyond single-host self-hosting

That keeps the work proportional to the project’s actual role: a hardened
alert-forwarder, not a secure vault.
