/**
 * Shared types for the inbound email pipeline.
 *
 * Imported by queue.ts, deliver.ts, and index.ts.
 * Do not add business logic here — types only.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import type { EmailAddress, DeliveryLog } from "../../db/schema.js";
import type { parseEmail } from "../parser.js";
import type { StorageEncryptionMetadata } from "../../security/encryption.js";

export type Db = NodePgDatabase<typeof schema>;

export interface PipelineInput {
  rawEmail: Buffer;
  /** Path where the raw email was persisted on disk (for retry). */
  rawEmailPath?: string;
  localPart: string;
  recipientDomain?: string;
  /** HTTP request ID for correlating pipeline log entries to an inbound request. */
  correlationId?: string;
  /**
   * SMTP envelope sender (MAIL FROM) as received by the Cloudflare Worker via message.from.
   * This is the authoritative value for allow-rule enforcement — it cannot be spoofed by
   * the email body. When present it takes precedence over the From: header parsed from MIME.
   */
  envelopeFrom?: string;
  /** Public base URL for building attachment download links, e.g. https://mail.example.com */
  publicBaseUrl: string;
  /** Encryption metadata for the persisted raw email file, if one exists. */
  rawEmailEncryption?: StorageEncryptionMetadata;
  /** Directory where attachment files are stored */
  attachmentDir: string;
  /** Attachment download link TTL in hours */
  attachmentTtlHours: number;
  /** Raw email retention window in hours; privacy-mode links must not outlive it. */
  rawEmailTtlHours: number;
}

export interface PipelineResult {
  ok: boolean;
  reason?: string;
  /**
   * Owner of the alias that the rejection decision was made for, resolved
   * fresh inside the queue transaction. Callers must prefer this over any
   * alias row they resolved earlier in the request (ownership can change
   * between the route's lookup and the locked queue decision).
   */
  userId?: bigint;
  /**
   * Usage month the rejection decision was made against. Callers must use
   * this (not a recomputed "now") for notification claims so a request that
   * straddles the UTC month boundary cannot burn the fresh month's slot.
   */
  month?: string;
}

export interface QueuedInboundEmail {
  alias: EmailAddress;
  parsed: Awaited<ReturnType<typeof parseEmail>>;
  deliveryLog: DeliveryLog;
  envelopeFrom: string | null;
  publicBaseUrl: string;
  attachmentDir: string;
  attachmentTtlHours: number;
  rawEmailTtlHours: number;
  correlationId?: string;
}

export type QueueInboundResult =
  | {
      queued: true;
      job: QueuedInboundEmail;
      /**
       * Post-increment monthly usage captured inside the locked queue
       * transaction. The approaching-limit warning must use this instead of
       * re-reading usage, or a fast burst through the 80–99% band can pass
       * the threshold unobserved.
       */
      usage?: { month: string; deliveredCount: number };
    }
  | { queued: false; result: PipelineResult };
