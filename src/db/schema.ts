import {
  pgTable,
  bigint,
  varchar,
  boolean,
  timestamp,
  uuid,
  integer,
  smallint,
  text,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── organizations ───────────────────────────────────────────────────────────

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 255 }).notNull(),
    planCode: varchar("plan_code", { length: 32 }).notNull().default("free"),
    subscriptionStatus: varchar("subscription_status", { length: 32 }).notNull().default("free"),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_org_stripe_customer").on(t.stripeCustomerId),
    uniqueIndex("idx_org_stripe_subscription").on(t.stripeSubscriptionId),
    check(
      "chk_org_plan_code",
      sql`${t.planCode} in ('free', 'personal', 'pro', 'team', 'business')`,
    ),
    check(
      "chk_org_subscription_status",
      sql`${t.subscriptionStatus} in ('free', 'trialing', 'active', 'paused', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired')`,
    ),
  ],
);

// ─── users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: bigint("id", { mode: "bigint" }).primaryKey(),
  username: varchar("username", { length: 255 }),
  isAllowed: boolean("is_allowed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── organization_members ────────────────────────────────────────────────────

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index("idx_org_member_user").on(t.userId),
    check("chk_org_member_role", sql`${t.role} in ('owner', 'admin', 'member')`),
  ],
);

// ─── inbound_domains ─────────────────────────────────────────────────────────

export const inboundDomains = pgTable(
  "inbound_domains",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    domain: varchar("domain", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    verificationToken: varchar("verification_token", { length: 255 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_inbound_domain_domain").on(t.domain),
    index("idx_inbound_domain_org_status").on(t.organizationId, t.status),
    check("chk_inbound_domain_kind", sql`${t.kind} in ('shared', 'custom')`),
    check("chk_inbound_domain_status", sql`${t.status} in ('active', 'pending', 'disabled')`),
    check(
      "chk_inbound_domain_ownership",
      sql`(${t.kind} = 'shared' and ${t.organizationId} is null) or (${t.kind} = 'custom' and ${t.organizationId} is not null)`,
    ),
  ],
);

// ─── email_addresses ─────────────────────────────────────────────────────────

export const emailAddresses = pgTable(
  "email_addresses",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    localPart: varchar("local_part", { length: 64 }).notNull(),
    fullAddress: varchar("full_address", { length: 320 }).notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id),
    domainId: uuid("domain_id").references(() => inboundDomains.id),
    chatId: bigint("chat_id", { mode: "bigint" }).notNull(),
    messageThreadId: bigint("message_thread_id", { mode: "bigint" }),
    createdBy: bigint("created_by", { mode: "bigint" })
      .notNull()
      .references(() => users.id),
    renderMode: varchar("render_mode", { length: 20 }).notNull().default("plaintext"),
    privacyModeEnabled: boolean("privacy_mode_enabled").notNull().default(false),
    bodyDedupEnabled: boolean("body_dedup_enabled").notNull().default(false),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    maxEmailsHour: integer("max_emails_hour").notNull().default(60),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_alias_local_part")
      .on(t.localPart)
      .where(sql`${t.domainId} is null`),
    index("idx_alias_active")
      .on(t.localPart)
      .where(sql`status = 'active'`),
    index("idx_alias_org").on(t.organizationId),
    uniqueIndex("idx_alias_domain_local_part")
      .on(t.domainId, t.localPart)
      .where(sql`${t.domainId} is not null`),
    index("idx_alias_chat").on(t.chatId),
  ],
);

// ─── allow_rules ─────────────────────────────────────────────────────────────

export const allowRules = pgTable(
  "allow_rules",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    emailAddressId: uuid("email_address_id")
      .notNull()
      .references(() => emailAddresses.id, { onDelete: "cascade" }),
    matchType: varchar("match_type", { length: 20 }).notNull(),
    matchValue: varchar("match_value", { length: 320 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_allow_alias").on(t.emailAddressId)],
);

// ─── delivery_logs ───────────────────────────────────────────────────────────

export const deliveryLogs = pgTable(
  "delivery_logs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    emailAddressId: uuid("email_address_id")
      .notNull()
      .references(() => emailAddresses.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id),
    messageIdHeader: varchar("message_id_header", { length: 998 }),
    bodySha256: varchar("body_sha256", { length: 64 }),
    bodyDedupApplied: boolean("body_dedup_applied").notNull().default(false),
    envelopeFrom: varchar("envelope_from", { length: 320 }),
    headerFrom: varchar("header_from", { length: 320 }),
    subject: text("subject"),
    metadataCiphertext: text("metadata_ciphertext"),
    metadataEncryptionMode: varchar("metadata_encryption_mode", { length: 20 })
      .notNull()
      .default("none"),
    metadataWrappedDek: text("metadata_wrapped_dek"),
    metadataKekKeyId: varchar("metadata_kek_key_id", { length: 255 }),
    metadataEncryptedAt: timestamp("metadata_encrypted_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    rawSizeBytes: integer("raw_size_bytes"),
    rawEmailPath: varchar("raw_email_path", { length: 512 }),
    rawEmailEncryptionMode: varchar("raw_email_encryption_mode", { length: 20 })
      .notNull()
      .default("none"),
    rawEmailWrappedDek: text("raw_email_wrapped_dek"),
    rawEmailKekKeyId: varchar("raw_email_kek_key_id", { length: 255 }),
    rawEmailEncryptedAt: timestamp("raw_email_encrypted_at", { withTimezone: true }),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    finalStatus: varchar("final_status", { length: 20 }).notNull().default("received"),
    billable: boolean("billable").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_log_org_time").on(t.organizationId, t.receivedAt),
    index("idx_log_alias_time").on(t.emailAddressId, t.receivedAt),
    index("idx_log_message_id").on(t.messageIdHeader),
    index("idx_log_body_hash").on(t.bodySha256),
    // Unique partial indexes enforce dedup at the DB level, closing the
    // SELECT-then-INSERT race when two requests arrive simultaneously.
    uniqueIndex("idx_log_dedup_msgid")
      .on(t.emailAddressId, t.messageIdHeader)
      .where(sql`message_id_header IS NOT NULL`),
    uniqueIndex("idx_log_dedup_bodyhash")
      .on(t.emailAddressId, t.bodySha256)
      .where(sql`body_sha256 IS NOT NULL AND body_dedup_applied = true`),
  ],
);

// ─── delivery_attempts ───────────────────────────────────────────────────────

export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    deliveryLogId: uuid("delivery_log_id")
      .notNull()
      .references(() => deliveryLogs.id, { onDelete: "cascade" }),
    attemptNo: smallint("attempt_no").notNull(),
    targetChatId: bigint("target_chat_id", { mode: "bigint" }).notNull(),
    targetThreadId: bigint("target_thread_id", { mode: "bigint" }),
    telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }),
    status: varchar("status", { length: 20 }).notNull(),
    errorText: text("error_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_attempt_log").on(t.deliveryLogId)],
);

// ─── attachments ─────────────────────────────────────────────────────────────

export const attachments = pgTable("attachments", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  deliveryLogId: uuid("delivery_log_id")
    .notNull()
    .references(() => deliveryLogs.id, { onDelete: "cascade" }),
  originalFilename: varchar("original_filename", { length: 255 }),
  contentType: varchar("content_type", { length: 127 }),
  sizeBytes: integer("size_bytes"),
  sha256: varchar("sha256", { length: 64 }),
  storagePath: varchar("storage_path", { length: 512 }).notNull(),
  encryptionMode: varchar("encryption_mode", { length: 20 }).notNull().default("none"),
  wrappedDek: text("wrapped_dek"),
  kekKeyId: varchar("kek_key_id", { length: 255 }),
  encryptedAt: timestamp("encrypted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── attachment_links ────────────────────────────────────────────────────────

export const attachmentLinks = pgTable(
  "attachment_links",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => attachments.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 96 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idx_link_token").on(t.token), index("idx_link_expires").on(t.expiresAt)],
);

// ─── delivery_view_links ─────────────────────────────────────────────────────

export const deliveryViewLinks = pgTable(
  "delivery_view_links",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    deliveryLogId: uuid("delivery_log_id")
      .notNull()
      .references(() => deliveryLogs.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_delivery_view_link_token_hash").on(t.tokenHash),
    uniqueIndex("idx_delivery_view_link_delivery_log").on(t.deliveryLogId),
    index("idx_delivery_view_link_expires").on(t.expiresAt),
  ],
);

// ─── chats ───────────────────────────────────────────────────────────────────

export const chats = pgTable("chats", {
  id: bigint("id", { mode: "bigint" }).primaryKey(),
  organizationId: uuid("organization_id").references(() => organizations.id),
  title: varchar("title", { length: 255 }).notNull(),
  type: varchar("type", { length: 20 }).notNull(), // 'private' | 'group' | 'supergroup' | 'channel'
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── organization_usage_months ───────────────────────────────────────────────

export const organizationUsageMonths = pgTable(
  "organization_usage_months",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    month: varchar("month", { length: 7 }).notNull(),
    deliveredCount: integer("delivered_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    egressBytes: bigint("egress_bytes", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.month] }),
    check("chk_org_usage_month", sql`${t.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check("chk_org_usage_delivered_nonnegative", sql`${t.deliveredCount} >= 0`),
    check("chk_org_usage_rejected_nonnegative", sql`${t.rejectedCount} >= 0`),
    check("chk_org_usage_egress_nonnegative", sql`${t.egressBytes} >= 0`),
  ],
);

// ─── organization_storage_usage ──────────────────────────────────────────────

export const organizationStorageUsage = pgTable(
  "organization_storage_usage",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    rawEmailBytes: bigint("raw_email_bytes", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    attachmentBytes: bigint("attachment_bytes", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("chk_org_storage_raw_nonnegative", sql`${t.rawEmailBytes} >= 0`),
    check("chk_org_storage_attachment_nonnegative", sql`${t.attachmentBytes} >= 0`),
  ],
);

// ─── billing_webhook_events ──────────────────────────────────────────────────

export const billingWebhookEvents = pgTable("billing_webhook_events", {
  eventId: varchar("event_id", { length: 255 }).primaryKey(),
  eventType: varchar("event_type", { length: 255 }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Type exports ─────────────────────────────────────────────────────────────

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;
export type InboundDomain = typeof inboundDomains.$inferSelect;
export type NewInboundDomain = typeof inboundDomains.$inferInsert;
export type EmailAddress = typeof emailAddresses.$inferSelect;
export type NewEmailAddress = typeof emailAddresses.$inferInsert;
export type AllowRule = typeof allowRules.$inferSelect;
export type NewAllowRule = typeof allowRules.$inferInsert;
export type DeliveryLog = typeof deliveryLogs.$inferSelect;
export type NewDeliveryLog = typeof deliveryLogs.$inferInsert;
export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect;
export type NewDeliveryAttempt = typeof deliveryAttempts.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
export type AttachmentLink = typeof attachmentLinks.$inferSelect;
export type NewAttachmentLink = typeof attachmentLinks.$inferInsert;
export type DeliveryViewLink = typeof deliveryViewLinks.$inferSelect;
export type NewDeliveryViewLink = typeof deliveryViewLinks.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type OrganizationUsageMonth = typeof organizationUsageMonths.$inferSelect;
export type NewOrganizationUsageMonth = typeof organizationUsageMonths.$inferInsert;
export type OrganizationStorageUsage = typeof organizationStorageUsage.$inferSelect;
export type NewOrganizationStorageUsage = typeof organizationStorageUsage.$inferInsert;
export type BillingWebhookEvent = typeof billingWebhookEvents.$inferSelect;
export type NewBillingWebhookEvent = typeof billingWebhookEvents.$inferInsert;
