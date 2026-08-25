// AUTO-GENERATED FROM drizzle/schema.ts. Review against supabase/migrations before use.
import {
  bigint,
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const pgEnumText = <T extends readonly string[]>(name: string, _values: T) =>
  varchar(name, { length: 64 }).$type<T[number]>();

export const users = pgTable("users", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  openId: uuid("auth_user_id").notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("login_method", { length: 64 }),
  role: pgEnumText("role", ["user", "admin"]).default("user").notNull(),
  platformRole: pgEnumText("platform_role", ["platform_owner", "platform_admin", "finance_admin"]),
  accountStatus: pgEnumText("account_status", ["active", "locked", "disabled"]).default("active").notNull(),
  mustChangePassword: boolean("must_change_password").default(false).notNull(),
  temporaryPasswordIssuedAt: timestamp("temporary_password_issued_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  lastSignedIn: timestamp("last_signed_in").defaultNow().notNull(),
});

export const userQuickActionPreferences = pgTable("user_quick_action_preferences", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  actionIds: jsonb("action_ids").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("user_quick_actions_user_site_unique").on(table.userId, table.siteId),
  index("user_quick_actions_site_idx").on(table.siteId),
]);

export const mobileApiSessions = pgTable("mobile_api_sessions", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  refreshTokenHash: varchar("refresh_token_hash", { length: 128 }).notNull().unique(),
  deviceLabel: varchar("device_label", { length: 160 }),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  lastUsedAt: timestamp("last_used_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("mobile_api_sessions_user_tenant_idx").on(table.userId, table.tenantId, table.revokedAt),
  index("mobile_api_sessions_expiry_idx").on(table.expiresAt),
]);

export const mobileSyncEvents = pgTable("mobile_sync_events", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
  sessionId: bigint("session_id", { mode: "number" }).references(() => mobileApiSessions.id),
  eventKey: varchar("event_key", { length: 128 }).notNull(),
  eventType: pgEnumText("event_type", ["sync_cycle", "sync_error"]).notNull(),
  status: pgEnumText("status", ["success", "partial", "retryable", "needs_review", "failed"]).notNull(),
  syncedCount: integer("synced_count").default(0).notNull(),
  retryableCount: integer("retryable_count").default(0).notNull(),
  needsReviewCount: integer("needs_review_count").default(0).notNull(),
  errorCode: varchar("error_code", { length: 100 }),
  errorMessage: text("error_message"),
  appVersion: varchar("app_version", { length: 64 }),
  deviceLabel: varchar("device_label", { length: 160 }),
  metadata: jsonb("metadata"),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("mobile_sync_events_tenant_event_key_unique").on(table.tenantId, table.eventKey),
  index("mobile_sync_events_tenant_site_date_idx").on(table.tenantId, table.siteId, table.occurredAt),
  index("mobile_sync_events_tenant_user_date_idx").on(table.tenantId, table.userId, table.occurredAt),
  index("mobile_sync_events_site_status_date_idx").on(table.siteId, table.status, table.occurredAt),
]);

export const tenants = pgTable("tenants", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  status: pgEnumText("status", ["active", "suspended", "archived"]).default("active").notNull(),
  plan: pgEnumText("plan", ["starter", "professional", "enterprise"]).default("starter").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const tenantOwnerProfiles = pgTable("tenant_owner_profiles", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  ownerUserId: bigint("owner_user_id", { mode: "number" }).references(() => users.id),
  fullName: varchar("full_name", { length: 180 }).notNull(),
  phone: varchar("phone", { length: 30 }).notNull(),
  whatsappNumber: varchar("whatsapp_number", { length: 30 }),
  email: varchar("email", { length: 320 }),
  companyName: varchar("company_name", { length: 180 }),
  reportLogoKey: varchar("report_logo_key", { length: 500 }),
  identityNumberCiphertext: text("identity_number_ciphertext"),
  identityNumberIv: varchar("identity_number_iv", { length: 64 }),
  identityNumberLast4: varchar("identity_number_last4", { length: 4 }),
  invitedAt: timestamp("invited_at"),
  claimedAt: timestamp("claimed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_owner_profile_tenant_unique").on(table.tenantId),
  uniqueIndex("tenant_owner_profile_phone_unique").on(table.phone),
  uniqueIndex("tenant_owner_profile_email_unique").on(table.email),
  index("tenant_owner_profile_user_idx").on(table.ownerUserId),
]);

export const tenantSubscriptions = pgTable("tenant_subscriptions", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  plan: pgEnumText("plan", ["starter", "professional", "enterprise"]).default("starter").notNull(),
  status: pgEnumText("status", ["trial", "active", "overdue", "suspended", "cancelled"]).default("trial").notNull(),
  billingCycle: pgEnumText("billing_cycle", ["monthly", "yearly"]).default("monthly").notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endsAt: timestamp("ends_at").notNull(),
  autoRenew: boolean("auto_renew").default(false).notNull(),
  renewalCount: integer("renewal_count").default(0).notNull(),
  lastRenewedAt: timestamp("last_renewed_at"),
  notes: text("notes"),
  smsPlanId: bigint("sms_plan_id", { mode: "number" }).references(() => platformSmsPlans.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_subscription_tenant_unique").on(table.tenantId),
  index("tenant_subscription_status_end_idx").on(table.status, table.endsAt),
]);

export const platformSmsPlans = pgTable("platform_sms_plans", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  code: varchar("code", { length: 80 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  includedMessages: integer("included_messages").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const smsPackageRequests = pgTable("sms_package_requests", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  requestedByUserId: bigint("requested_by_user_id", { mode: "number" }).notNull().references(() => users.id),
  requestedMessages: integer("requested_messages").notNull(),
  approvedMessages: integer("approved_messages").default(0).notNull(),
  status: pgEnumText("status", ["pending", "approved", "rejected", "cancelled"]).default("pending").notNull(),
  note: text("note"),
  reviewedByUserId: bigint("reviewed_by_user_id", { mode: "number" }).references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("sms_package_requests_tenant_status_idx").on(table.tenantId, table.status),
  index("sms_package_requests_status_date_idx").on(table.status, table.createdAt),
]);

export const tenantBranchSettings = pgTable("tenant_branch_settings", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  isEnabledOverride: boolean("is_enabled_override"),
  maxBranchesOverride: integer("max_branches_override"),
  disabledBehavior: pgEnumText("disabled_behavior", ["read_only", "suspended"]).default("read_only").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_branch_settings_tenant_unique").on(table.tenantId),
]);

export const subscriptionUpgradeRequests = pgTable("subscription_upgrade_requests", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  requestedByUserId: bigint("requested_by_user_id", { mode: "number" }).notNull().references(() => users.id),
  currentPlan: pgEnumText("current_plan", ["starter", "professional", "enterprise"]).notNull(),
  requestedPlan: pgEnumText("requested_plan", ["starter", "professional", "enterprise"]).notNull(),
  reason: varchar("reason", { length: 80 }).default("subscriber_limit_reached").notNull(),
  status: pgEnumText("status", ["pending", "reviewing", "approved", "rejected", "cancelled"]).default("pending").notNull(),
  note: text("note"),
  reviewedByUserId: bigint("reviewed_by_user_id", { mode: "number" }).references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("subscription_upgrade_request_tenant_status_idx").on(table.tenantId, table.status),
  index("subscription_upgrade_request_status_date_idx").on(table.status, table.createdAt),
]);

export const tenantMembers = pgTable("tenant_members", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
  role: pgEnumText("role", ["owner", "admin", "member"]).default("member").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  membershipStatus: pgEnumText("membership_status", ["invited", "active", "suspended", "revoked"]).default("active").notNull(),
  invitedByUserId: bigint("invited_by_user_id", { mode: "number" }).references(() => users.id),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_member_unique").on(table.tenantId, table.userId),
  index("tenant_member_user_idx").on(table.userId, table.isActive),
]);

export const tenantMessagingConfigurations = pgTable("tenant_messaging_configurations", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  channel: pgEnumText("channel", ["whatsapp", "sms"]).notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  senderId: varchar("sender_id", { length: 120 }),
  phoneNumberId: varchar("phone_number_id", { length: 120 }),
  templateName: varchar("template_name", { length: 120 }),
  receiptTemplateName: varchar("receipt_template_name", { length: 120 }),
  subscriberReferenceTemplateName: varchar("subscriber_reference_template_name", { length: 120 }),
  credentialCiphertext: text("credential_ciphertext"),
  credentialIv: varchar("credential_iv", { length: 64 }),
  credentialKeyVersion: integer("credential_key_version").default(1).notNull(),
  webhookVerifyTokenHash: varchar("webhook_verify_token_hash", { length: 128 }),
  isActive: boolean("is_active").default(false).notNull(),
  autoSendAfterApproval: boolean("auto_send_after_approval").default(false).notNull(),
  autoSendCron: varchar("auto_send_cron", { length: 40 }),
  scheduleCronTaskUid: varchar("schedule_cron_task_uid", { length: 65 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_channel_unique").on(table.tenantId, table.channel),
  index("tenant_messaging_schedule_task_idx").on(table.scheduleCronTaskUid),
]);

export const tenantTweetSmsAccounts = pgTable("tenant_tweetsms_accounts", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  apiEndpoint: varchar("api_endpoint", { length: 500 }),
  credentialCiphertext: text("credential_ciphertext"),
  credentialIv: varchar("credential_iv", { length: 64 }),
  credentialKeyVersion: integer("credential_key_version").default(1).notNull(),
  senderName: varchar("sender_name", { length: 120 }),
  monthlyLimit: integer("monthly_limit").default(0).notNull(),
  isActive: boolean("is_active").default(false).notNull(),
  lastTestedAt: timestamp("last_tested_at"),
  lastError: text("last_error"),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id),
  updatedByUserId: bigint("updated_by_user_id", { mode: "number" }).references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_tweetsms_account_unique").on(table.tenantId),
  index("tenant_tweetsms_account_active_idx").on(table.isActive),
]);

export const platformTweetSmsAccounts = pgTable("platform_tweetsms_accounts", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  apiEndpoint: varchar("api_endpoint", { length: 500 }).notNull(),
  credentialCiphertext: text("credential_ciphertext").notNull(),
  credentialIv: varchar("credential_iv", { length: 64 }).notNull(),
  credentialKeyVersion: integer("credential_key_version").default(1).notNull(),
  senderName: varchar("sender_name", { length: 120 }),
  lowBalanceThreshold: integer("low_balance_threshold").default(100).notNull(),
  lastProviderBalance: integer("last_provider_balance"),
  lastBalanceCheckedAt: timestamp("last_balance_checked_at"),
  lastTestedAt: timestamp("last_tested_at"),
  lastError: text("last_error"),
  isActive: boolean("is_active").default(false).notNull(),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id),
  updatedByUserId: bigint("updated_by_user_id", { mode: "number" }).references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("platform_tweetsms_account_active_idx").on(table.isActive),
]);

export const platformTweetSmsBalanceAlerts = pgTable("platform_tweetsms_balance_alerts", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  accountId: bigint("account_id", { mode: "number" }).notNull().references(() => platformTweetSmsAccounts.id),
  balance: integer("balance").notNull(),
  threshold: integer("threshold").notNull(),
  status: pgEnumText("status", ["open", "resolved"]).default("open").notNull(),
  notifiedAt: timestamp("notified_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("platform_tweetsms_alert_account_status_idx").on(table.accountId, table.status),
]);

export const platformSmsFallbackProviders = pgTable("platform_sms_fallback_providers", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  providerKey: varchar("provider_key", { length: 80 }).notNull().unique(),
  apiEndpoint: varchar("api_endpoint", { length: 500 }),
  credentialCiphertext: text("credential_ciphertext"),
  credentialIv: varchar("credential_iv", { length: 64 }),
  credentialKeyVersion: integer("credential_key_version").default(1).notNull(),
  senderName: varchar("sender_name", { length: 120 }),
  priority: integer("priority").default(100).notNull(),
  integrationStatus: pgEnumText("integration_status", ["pending_contract", "ready"]).default("pending_contract").notNull(),
  isActive: boolean("is_active").default(false).notNull(),
  lastTestedAt: timestamp("last_tested_at"),
  lastError: text("last_error"),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id),
  updatedByUserId: bigint("updated_by_user_id", { mode: "number" }).references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("platform_sms_fallback_active_priority_idx").on(table.isActive, table.priority),
]);

export const tenantInvoiceMessageTemplates = pgTable("tenant_invoice_message_templates", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  channel: pgEnumText("channel", ["whatsapp", "sms"]).notNull(),
  eventType: pgEnumText("event_type", ["invoice_issued"]).default("invoice_issued").notNull(),
  body: text("body").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_invoice_template_unique").on(table.tenantId, table.channel, table.eventType),
]);

export const tenantPaymentReceiptMessageTemplates = pgTable("tenant_payment_receipt_message_templates", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  channel: pgEnumText("channel", ["sms"]).default("sms").notNull(),
  body: text("body").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_payment_receipt_template_unique").on(table.tenantId, table.channel),
]);

export const sites = pgTable("sites", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  name: varchar("name", { length: 160 }).notNull(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  city: varchar("city", { length: 100 }),
  address: text("address"),
  status: pgEnumText("status", ["active", "inactive", "archived"]).default("active").notNull(),
  anomalyAlertPercent: integer("anomaly_alert_percent").default(50).notNull(),
  invoiceDueDays: integer("invoice_due_days").default(14).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const sitePortalSettings = pgTable("site_portal_settings", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  portalCode: varchar("portal_code", { length: 50 }).notNull(),
  displayName: varchar("display_name", { length: 160 }),
  primaryColor: varchar("primary_color", { length: 20 }).default("#0D1117").notNull(),
  accentColor: varchar("accent_color", { length: 20 }).default("#F5B800").notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("site_portal_settings_site_unique").on(table.siteId),
  uniqueIndex("site_portal_settings_code_unique").on(table.portalCode),
  index("site_portal_settings_tenant_idx").on(table.tenantId),
]);

export const accessInvitations = pgTable("access_invitations", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).references(() => sites.id),
  email: varchar("email", { length: 320 }).notNull(),
  tenantRole: pgEnumText("tenant_role", ["owner", "admin", "member"]).default("member").notNull(),
  siteRole: pgEnumText("site_role", ["owner", "manager", "accountant", "collector", "technician", "viewer"]),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  status: pgEnumText("status", ["invited", "accepted", "suspended", "revoked", "expired"]).default("invited").notNull(),
  invitedByUserId: bigint("invited_by_user_id", { mode: "number" }).notNull().references(() => users.id),
  acceptedByUserId: bigint("accepted_by_user_id", { mode: "number" }).references(() => users.id),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("access_invitation_tenant_email_status_idx").on(table.tenantId, table.email, table.status),
  index("access_invitation_email_status_idx").on(table.email, table.status),
]);

export const platformAccessInvitations = pgTable("platform_access_invitations", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  platformRole: pgEnumText("platform_role", ["platform_owner", "platform_admin", "finance_admin"]).notNull(),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  status: pgEnumText("status", ["invited", "accepted", "revoked", "expired"]).default("invited").notNull(),
  invitedByUserId: bigint("invited_by_user_id", { mode: "number" }).notNull().references(() => users.id),
  acceptedByUserId: bigint("accepted_by_user_id", { mode: "number" }).references(() => users.id),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("platform_access_invitation_email_status_idx").on(table.email, table.status),
]);

export const customPermissionRoles = pgTable("custom_permission_roles", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  name: varchar("name", { length: 120 }).notNull(),
  description: varchar("description", { length: 255 }),
  permissions: jsonb("permissions").$type<string[]>().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("custom_permission_role_tenant_name_unique").on(table.tenantId, table.name),
  index("custom_permission_role_tenant_active_idx").on(table.tenantId, table.isActive),
]);

export const staffProfiles = pgTable("staff_profiles", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
  tenantId: bigint("tenant_id", { mode: "number" }).references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).references(() => sites.id),
  role: pgEnumText("role", ["owner", "manager", "accountant", "collector", "technician", "viewer"]).notNull(),
  customRoleId: bigint("custom_role_id", { mode: "number" }).references(() => customPermissionRoles.id),
  permissions: jsonb("permissions").$type<string[] | null>(),
  suspensionStartedAt: timestamp("suspension_started_at"),
  suspensionEndsAt: timestamp("suspension_ends_at"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("staff_user_site_role_unique").on(table.userId, table.siteId, table.role),
  index("staff_tenant_site_active_idx").on(table.tenantId, table.siteId, table.isActive),
]);

export const employees = pgTable("employees", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).references(() => sites.id),
  linkedUserId: bigint("linked_user_id", { mode: "number" }).references(() => users.id),
  fullName: varchar("full_name", { length: 180 }).notNull(),
  identityNo: varchar("identity_no", { length: 80 }),
  phone: varchar("phone", { length: 40 }),
  jobTitle: pgEnumText("job_title", ["accountant", "collector", "technician", "worker", "supervisor", "other"]).notNull(),
  employmentStatus: pgEnumText("employment_status", ["active", "suspended", "ended"]).default("active").notNull(),
  contractType: pgEnumText("contract_type", ["daily", "monthly", "collection_percentage"]).notNull(),
  baseWage: decimal("base_wage", { precision: 12, scale: 2 }).notNull(),
  hireDate: timestamp("hire_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("employees_tenant_status_idx").on(table.tenantId, table.employmentStatus),
  index("employees_tenant_site_idx").on(table.tenantId, table.siteId),
  index("employees_tenant_phone_idx").on(table.tenantId, table.phone),
]);

export const employeeAttendance = pgTable("employee_attendance", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  employeeId: bigint("employee_id", { mode: "number" }).notNull().references(() => employees.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  workDate: timestamp("work_date").notNull(),
  regularHours: decimal("regular_hours", { precision: 5, scale: 2 }).default("0").notNull(),
  overtimeHours: decimal("overtime_hours", { precision: 5, scale: 2 }).default("0").notNull(),
  absentDays: decimal("absent_days", { precision: 4, scale: 2 }).default("0").notNull(),
  notes: varchar("notes", { length: 500 }),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [uniqueIndex("employee_attendance_employee_date_unique").on(table.employeeId, table.workDate), index("employee_attendance_tenant_site_date_idx").on(table.tenantId, table.siteId, table.workDate)]);

export const employeeAdjustments = pgTable("employee_adjustments", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  employeeId: bigint("employee_id", { mode: "number" }).notNull().references(() => employees.id),
  siteId: bigint("site_id", { mode: "number" }).references(() => sites.id),
  adjustmentType: pgEnumText("adjustment_type", ["advance", "deduction"]).notNull(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  remainingAmount: decimal("remaining_amount", { precision: 12, scale: 2 }).notNull(),
  reason: varchar("reason", { length: 255 }).notNull(),
  status: pgEnumText("status", ["open", "settled", "cancelled"]).default("open").notNull(),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [index("employee_adjustments_tenant_employee_idx").on(table.tenantId, table.employeeId), index("employee_adjustments_tenant_status_idx").on(table.tenantId, table.status)]);

export const payrollRuns = pgTable("payroll_runs", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).references(() => sites.id),
  period: varchar("period", { length: 7 }).notNull(),
  status: pgEnumText("status", ["draft", "approved", "paid", "cancelled"]).default("draft").notNull(),
  totalGross: decimal("total_gross", { precision: 14, scale: 2 }).default("0").notNull(),
  totalDeductions: decimal("total_deductions", { precision: 14, scale: 2 }).default("0").notNull(),
  totalNet: decimal("total_net", { precision: 14, scale: 2 }).default("0").notNull(),
  paidFromAccountId: bigint("paid_from_account_id", { mode: "number" }).references(() => companyAccounts.id),
  approvedByUserId: bigint("approved_by_user_id", { mode: "number" }).references(() => users.id),
  paidAt: timestamp("paid_at"),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [uniqueIndex("payroll_runs_tenant_site_period_unique").on(table.tenantId, table.siteId, table.period), index("payroll_runs_tenant_status_idx").on(table.tenantId, table.status)]);

export const payrollItems = pgTable("payroll_items", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  payrollRunId: bigint("payroll_run_id", { mode: "number" }).notNull().references(() => payrollRuns.id),
  employeeId: bigint("employee_id", { mode: "number" }).notNull().references(() => employees.id),
  baseAmount: decimal("base_amount", { precision: 12, scale: 2 }).notNull(),
  extraAmount: decimal("extra_amount", { precision: 12, scale: 2 }).default("0").notNull(),
  advanceDeduction: decimal("advance_deduction", { precision: 12, scale: 2 }).default("0").notNull(),
  otherDeduction: decimal("other_deduction", { precision: 12, scale: 2 }).default("0").notNull(),
  netAmount: decimal("net_amount", { precision: 12, scale: 2 }).notNull(),
  notes: text("notes"),
}, (table) => [uniqueIndex("payroll_items_run_employee_unique").on(table.payrollRunId, table.employeeId)]);

export const generators = pgTable("generators", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  code: varchar("code", { length: 50 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  serialNumber: varchar("serial_number", { length: 100 }),
  ratedCapacityKw: decimal("rated_capacity_kw", { precision: 12, scale: 3 }).notNull(),
  fuelType: pgEnumText("fuel_type", ["diesel", "gasoline", "gas", "other"]).default("diesel").notNull(),
  fuelLevelLiters: decimal("fuel_level_liters", { precision: 12, scale: 2 }).default("0").notNull(),
  operatingHours: decimal("operating_hours", { precision: 12, scale: 2 }).default("0").notNull(),
  status: pgEnumText("status", ["pending", "active", "maintenance", "stopped", "offline", "blocked"]).default("pending").notNull(),
  lastMaintenanceAt: timestamp("last_maintenance_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("generator_site_code_unique").on(table.siteId, table.code),
  uniqueIndex("generator_name_unique").on(table.name),
  index("generators_tenant_site_idx").on(table.tenantId, table.siteId),
  index("generators_site_status_idx").on(table.siteId, table.status),
]);

export const subscribers = pgTable("subscribers", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  subscriberNo: varchar("subscriber_no", { length: 50 }).notNull(),
  clientOperationId: varchar("client_operation_id", { length: 80 }),
  fullName: varchar("full_name", { length: 180 }).notNull(),
  phone: varchar("phone", { length: 30 }).notNull(),
  whatsappNumber: varchar("whatsapp_number", { length: 30 }),
  address: text("address"),
  subscriptionType: pgEnumText("subscription_type", ["residential", "commercial"]).default("residential").notNull(),
  serviceStatus: pgEnumText("service_status", ["active", "suspended", "disconnected"]).default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("subscriber_site_number_unique").on(table.siteId, table.subscriberNo),
  uniqueIndex("subscriber_client_operation_unique").on(table.clientOperationId),
  index("subscribers_tenant_site_idx").on(table.tenantId, table.siteId),
  index("subscribers_site_status_idx").on(table.siteId, table.serviceStatus),
]);

export const meters = pgTable("meters", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  subscriberId: bigint("subscriber_id", { mode: "number" }).notNull().references(() => subscribers.id),
  generatorId: bigint("generator_id", { mode: "number" }).references(() => generators.id),
  serialNumber: varchar("serial_number", { length: 100 }).notNull().unique(),
  meterType: pgEnumText("meter_type", ["manual", "digital", "smart"]).default("manual").notNull(),
  multiplier: decimal("multiplier", { precision: 8, scale: 3 }).default("1").notNull(),
  installedAt: timestamp("installed_at").defaultNow().notNull(),
  status: pgEnumText("status", ["active", "replaced", "damaged", "offline"]).default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const tariffs = pgTable("tariffs", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  name: varchar("name", { length: 160 }).notNull(),
  code: varchar("code", { length: 50 }).notNull(),
  pricePerKwh: decimal("price_per_kwh", { precision: 14, scale: 4 }).notNull(),
  fixedFee: decimal("fixed_fee", { precision: 14, scale: 2 }).default("0").notNull(),
  taxRate: decimal("tax_rate", { precision: 7, scale: 4 }).default("0").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("tariff_site_code_unique").on(table.siteId, table.code),
  index("tariffs_tenant_site_idx").on(table.tenantId, table.siteId),
]);

export const meterReadings = pgTable("meter_readings", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  subscriberId: bigint("subscriber_id", { mode: "number" }).notNull().references(() => subscribers.id),
  clientOperationId: varchar("client_operation_id", { length: 80 }).unique(),
  readingAt: timestamp("reading_at").defaultNow().notNull(),
  readingValue: decimal("reading_value", { precision: 15, scale: 3 }).notNull(),
  previousReadingValue: decimal("previous_reading_value", { precision: 15, scale: 3 }),
  consumptionKwh: decimal("consumption_kwh", { precision: 15, scale: 3 }),
  captureMethod: pgEnumText("capture_method", ["manual", "photo", "smart_meter"]).default("manual").notNull(),
  imageKey: varchar("image_key", { length: 500 }),
  imageHash: varchar("image_hash", { length: 128 }),
  status: pgEnumText("status", ["draft", "pending_review", "approved", "rejected"]).default("pending_review").notNull(),
  enteredByUserId: bigint("entered_by_user_id", { mode: "number" }).references(() => users.id),
  reviewedByUserId: bigint("reviewed_by_user_id", { mode: "number" }).references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  notes: text("notes"),
  versionNo: integer("version_no").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("readings_subscriber_date_idx").on(table.subscriberId, table.readingAt),
  index("readings_status_idx").on(table.status),
]);

export const invoices = pgTable("invoices", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  subscriberId: bigint("subscriber_id", { mode: "number" }).notNull().references(() => subscribers.id),
  readingId: bigint("reading_id", { mode: "number" }).references(() => meterReadings.id),
  tariffId: bigint("tariff_id", { mode: "number" }).references(() => tariffs.id),
  invoiceNo: varchar("invoice_no", { length: 60 }).notNull().unique(),
  clientOperationId: varchar("client_operation_id", { length: 80 }),
  billingPeriod: varchar("billing_period", { length: 7 }).notNull(),
  issueDate: timestamp("issue_date").defaultNow().notNull(),
  dueDate: timestamp("due_date").notNull(),
  previousReading: decimal("previous_reading", { precision: 15, scale: 3 }),
  currentReading: decimal("current_reading", { precision: 15, scale: 3 }),
  consumptionKwh: decimal("consumption_kwh", { precision: 15, scale: 3 }).default("0").notNull(),
  pricePerKwh: decimal("price_per_kwh", { precision: 14, scale: 4 }).default("0").notNull(),
  fixedFee: decimal("fixed_fee", { precision: 14, scale: 2 }).default("0").notNull(),
  taxAmount: decimal("tax_amount", { precision: 14, scale: 2 }).default("0").notNull(),
  discountAmount: decimal("discount_amount", { precision: 14, scale: 2 }).default("0").notNull(),
  totalAmount: decimal("total_amount", { precision: 14, scale: 2 }).default("0").notNull(),
  paidAmount: decimal("paid_amount", { precision: 14, scale: 2 }).default("0").notNull(),
  balanceDue: decimal("balance_due", { precision: 14, scale: 2 }).default("0").notNull(),
  status: pgEnumText("status", ["draft", "issued", "partially_paid", "paid", "overdue", "cancelled"]).default("draft").notNull(),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("invoice_subscriber_period_unique").on(table.subscriberId, table.billingPeriod),
  uniqueIndex("invoice_client_operation_unique").on(table.clientOperationId),
  index("invoices_tenant_site_idx").on(table.tenantId, table.siteId),
  index("invoices_site_status_idx").on(table.siteId, table.status),
]);

/**
 * تثبت نتيجة كل عملية تشغيلية قادمة من طابور محلي مرة واحدة فقط. لا تخزن
 * مدفوعات أو أرصدة هنا؛ السجل مخصص للمسودات الآمنة مثل المشترك والفاتورة.
 */
export const offlineSyncOperations = pgTable("offline_sync_operations", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
  clientOperationId: varchar("client_operation_id", { length: 80 }).notNull(),
  operationType: pgEnumText("operation_type", ["subscriber_create", "subscriber_update", "invoice_issue", "payment_create"]).notNull(),
  entityType: varchar("entity_type", { length: 80 }).notNull(),
  entityId: bigint("entity_id", { mode: "number" }).notNull(),
  response: jsonb("response").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("offline_sync_actor_operation_unique").on(table.userId, table.clientOperationId),
  index("offline_sync_tenant_site_created_idx").on(table.tenantId, table.siteId, table.createdAt),
]);

export const invoiceLines = pgTable("invoice_lines", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  invoiceId: bigint("invoice_id", { mode: "number" }).notNull().references(() => invoices.id),
  lineType: pgEnumText("line_type", ["energy", "fixed_fee", "tax", "discount", "late_fee", "other"]).notNull(),
  description: varchar("description", { length: 255 }).notNull(),
  quantity: decimal("quantity", { precision: 15, scale: 3 }).default("1").notNull(),
  unitPrice: decimal("unit_price", { precision: 14, scale: 4 }).default("0").notNull(),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  displayOrder: integer("display_order").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("invoice_lines_invoice_idx").on(table.invoiceId, table.displayOrder),
]);

export const invoiceShareLinks = pgTable("invoice_share_links", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  invoiceId: bigint("invoice_id", { mode: "number" }).notNull().references(() => invoices.id),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  tokenPreview: varchar("token_preview", { length: 20 }).notNull(),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  viewCount: integer("view_count").default(0).notNull(),
  lastViewedAt: timestamp("last_viewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const collectorSessions = pgTable("collector_sessions", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  collectorUserId: bigint("collector_user_id", { mode: "number" }).notNull().references(() => users.id),
  status: pgEnumText("status", ["open", "closed"]).default("open").notNull(),
  openingCash: decimal("opening_cash", { precision: 14, scale: 2 }).default("0").notNull(),
  expectedCash: decimal("expected_cash", { precision: 14, scale: 2 }).default("0").notNull(),
  declaredCash: decimal("declared_cash", { precision: 14, scale: 2 }),
  varianceAmount: decimal("variance_amount", { precision: 14, scale: 2 }),
  openedAt: timestamp("opened_at").defaultNow().notNull(),
  closedAt: timestamp("closed_at"),
  notes: text("notes"),
  closedByUserId: bigint("closed_by_user_id", { mode: "number" }).references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("collector_sessions_tenant_site_idx").on(table.tenantId, table.siteId, table.status),
  index("collector_sessions_collector_status_idx").on(table.collectorUserId, table.status),
]);

export const payments = pgTable("payments", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  subscriberId: bigint("subscriber_id", { mode: "number" }).notNull().references(() => subscribers.id),
  invoiceId: bigint("invoice_id", { mode: "number" }).references(() => invoices.id),
  paymentNo: varchar("payment_no", { length: 60 }).notNull().unique(),
  clientOperationId: varchar("client_operation_id", { length: 80 }),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  paymentMethod: pgEnumText("payment_method", ["cash", "jawwal_pay", "palpay", "bank_of_palestine", "wallet", "bank_transfer", "card"]).default("cash").notNull(),
  transferFromAccount: varchar("transfer_from_account", { length: 30 }),
  transferFromType: pgEnumText("transfer_from_type", ["jawwal_pay", "palpay", "bank_of_palestine"]),
  transferToAccount: varchar("transfer_to_account", { length: 30 }),
  transferToType: pgEnumText("transfer_to_type", ["jawwal_pay", "palpay", "bank_of_palestine"]),
  referenceNo: varchar("reference_no", { length: 120 }),
  receiptImageKey: varchar("receipt_image_key", { length: 500 }),
  receiptImageHash: varchar("receipt_image_hash", { length: 64 }),
  status: pgEnumText("status", ["pending", "completed", "cancelled", "refunded"]).default("completed").notNull(),
  collectedByUserId: bigint("collected_by_user_id", { mode: "number" }).references(() => users.id),
  collectorSessionId: bigint("collector_session_id", { mode: "number" }).references(() => collectorSessions.id),
  paidAt: timestamp("paid_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("payment_client_operation_unique").on(table.clientOperationId),
  index("payments_tenant_site_idx").on(table.tenantId, table.siteId),
  index("payments_site_date_idx").on(table.siteId, table.paidAt),
]);

export const companyAccounts = pgTable("company_accounts", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  name: varchar("name", { length: 120 }).notNull(),
  accountType: pgEnumText("account_type", ["cash", "jawwal_pay", "palpay", "bank_of_palestine", "other"]).notNull(),
  // يمكن استخدام الرقم نفسه لحسابات من أنواع مختلفة؛ لا يوجد قيد تفرد على phoneNumber.
  phoneNumber: varchar("phone_number", { length: 30 }),
  color: varchar("color", { length: 20 }).default("#64748b").notNull(),
  openingBalance: decimal("opening_balance", { precision: 14, scale: 2 }).default("0").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [uniqueIndex("company_accounts_tenant_type_phone_unique").on(table.tenantId, table.accountType, table.phoneNumber), index("company_accounts_tenant_idx").on(table.tenantId)]);

export const companyAccountSites = pgTable("company_account_sites", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  accountId: bigint("account_id", { mode: "number" }).notNull().references(() => companyAccounts.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [uniqueIndex("company_account_sites_unique").on(table.accountId, table.siteId), index("company_account_sites_tenant_idx").on(table.tenantId)]);

export const accountTransactions = pgTable("account_transactions", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  accountId: bigint("account_id", { mode: "number" }).notNull().references(() => companyAccounts.id),
  transactionType: pgEnumText("transaction_type", ["deposit", "withdrawal", "transfer_in", "transfer_out", "collection"]).notNull(),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  description: varchar("description", { length: 255 }).notNull(),
  referenceNo: varchar("reference_no", { length: 120 }),
  relatedPaymentId: bigint("related_payment_id", { mode: "number" }).references(() => payments.id),
  relatedAccountId: bigint("related_account_id", { mode: "number" }).references(() => companyAccounts.id),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [index("account_transactions_tenant_account_date_idx").on(table.tenantId, table.accountId, table.occurredAt)]);

export const financialSettlements = pgTable("financial_settlements", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  totalCollected: decimal("total_collected", { precision: 14, scale: 2 }).default("0").notNull(),
  totalExpenses: decimal("total_expenses", { precision: 14, scale: 2 }).default("0").notNull(),
  bookProfit: decimal("book_profit", { precision: 14, scale: 2 }).default("0").notNull(),
  actualCash: decimal("actual_cash", { precision: 14, scale: 2 }),
  difference: decimal("difference", { precision: 14, scale: 2 }),
  notes: text("notes"),
  status: pgEnumText("status", ["draft", "submitted", "approved", "locked"]).default("draft").notNull(),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).notNull().references(() => users.id),
  approvedByUserId: bigint("approved_by_user_id", { mode: "number" }).references(() => users.id),
  lockedAt: timestamp("locked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [index("financial_settlements_tenant_site_period_idx").on(table.tenantId, table.siteId, table.periodStart, table.periodEnd)]);

export const expenses = pgTable("expenses", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  generatorId: bigint("generator_id", { mode: "number" }).references(() => generators.id),
  category: pgEnumText("category", ["fuel", "maintenance", "payroll", "parts", "transport", "other"]).notNull(),
  description: varchar("description", { length: 255 }).notNull(),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  referenceNo: varchar("reference_no", { length: 120 }),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("expenses_tenant_site_idx").on(table.tenantId, table.siteId),
  index("expenses_site_date_idx").on(table.siteId, table.occurredAt),
]);

export const notificationMessages = pgTable("notification_messages", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  invoiceId: bigint("invoice_id", { mode: "number" }).references(() => invoices.id),
  subscriberId: bigint("subscriber_id", { mode: "number" }).references(() => subscribers.id),
  channel: pgEnumText("channel", ["whatsapp", "sms"]).notNull(),
  eventType: pgEnumText("event_type", ["invoice_issued", "payment_reminder", "payment_received", "service_alert", "subscriber_reference"]).notNull(),
  recipient: varchar("recipient", { length: 50 }).notNull(),
  status: pgEnumText("status", ["pending", "submitted", "delivered", "read", "failed"]).default("pending").notNull(),
  providerMessageId: varchar("provider_message_id", { length: 200 }),
  payload: jsonb("payload"),
  attempts: integer("attempts").default(0).notNull(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const messagingScheduleRuns = pgTable("messaging_schedule_runs", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  configurationId: bigint("configuration_id", { mode: "number" }).notNull().references(() => tenantMessagingConfigurations.id),
  taskUid: varchar("task_uid", { length: 65 }),
  status: pgEnumText("status", ["success", "failed"]).default("success").notNull(),
  scanned: integer("scanned").default(0).notNull(),
  submitted: integer("submitted").default(0).notNull(),
  failed: integer("failed").default(0).notNull(),
  skipped: integer("skipped").default(0).notNull(),
  error: text("error"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
}, (table) => [
  index("messaging_schedule_runs_tenant_date_idx").on(table.tenantId, table.startedAt),
  index("messaging_schedule_runs_config_date_idx").on(table.configurationId, table.startedAt),
]);

export const platformSecurityEvents = pgTable("platform_security_events", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  eventType: pgEnumText("event_type", ["suspicious_login", "backup", "security_change"]).notNull(),
  severity: pgEnumText("severity", ["info", "warning", "critical"]).default("info").notNull(),
  status: pgEnumText("status", ["open", "resolved", "success", "failed"]).default("open").notNull(),
  title: varchar("title", { length: 180 }).notNull(),
  details: text("details"),
  metadata: jsonb("metadata"),
  relatedUserId: bigint("related_user_id", { mode: "number" }).references(() => users.id),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("platform_security_event_type_date_idx").on(table.eventType, table.createdAt),
  index("platform_security_event_status_idx").on(table.status, table.severity),
]);

export const platformSecuritySettings = pgTable("platform_security_settings", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  settingKey: varchar("setting_key", { length: 100 }).notNull(),
  isEnabled: boolean("is_enabled").default(false).notNull(),
  value: text("value"),
  updatedByUserId: bigint("updated_by_user_id", { mode: "number" }).references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("platform_security_setting_key_unique").on(table.settingKey),
]);

export const complaints = pgTable("complaints", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  subscriberId: bigint("subscriber_id", { mode: "number" }).references(() => subscribers.id),
  title: varchar("title", { length: 180 }).notNull(),
  description: text("description").notNull(),
  priority: pgEnumText("priority", ["low", "normal", "high", "urgent"]).default("normal").notNull(),
  status: pgEnumText("status", ["open", "assigned", "in_progress", "resolved", "closed"]).default("open").notNull(),
  assignedUserId: bigint("assigned_user_id", { mode: "number" }).references(() => users.id),
  response: text("response"),
  openedAt: timestamp("opened_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("complaints_tenant_site_status_idx").on(table.tenantId, table.siteId, table.status),
  index("complaints_assignee_status_idx").on(table.assignedUserId, table.status),
]);

export const platformTariffPolicies = pgTable("platform_tariff_policies", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  minimumPricePerKwh: decimal("minimum_price_per_kwh", { precision: 14, scale: 4 }).notNull(),
  maximumPricePerKwh: decimal("maximum_price_per_kwh", { precision: 14, scale: 4 }).notNull(),
  effectiveFrom: timestamp("effective_from").notNull(),
  notificationRequested: boolean("notification_requested").default(false).notNull(),
  notes: text("notes"),
  createdByUserId: bigint("created_by_user_id", { mode: "number" }).notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("platform_tariff_effective_idx").on(table.effectiveFrom),
]);

export const platformSettings = pgTable("platform_settings", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  settingKey: varchar("setting_key", { length: 100 }).notNull(),
  isEnabled: boolean("is_enabled").default(false).notNull(),
  value: jsonb("value"),
  message: text("message"),
  updatedByUserId: bigint("updated_by_user_id", { mode: "number" }).references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("platform_setting_key_unique").on(table.settingKey),
]);

export const platformRolePolicies = pgTable("platform_role_policies", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  role: pgEnumText("role", ["owner", "manager", "accountant", "collector", "technician", "viewer"]).notNull(),
  capability: pgEnumText("capability", ["manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"]).notNull(),
  isAllowed: boolean("is_allowed").default(true).notNull(),
  updatedByUserId: bigint("updated_by_user_id", { mode: "number" }).references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("platform_role_capability_unique").on(table.role, table.capability),
  index("platform_role_policy_role_idx").on(table.role),
]);

export const accessRecoveryRequests = pgTable("access_recovery_requests", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  ownerUserId: bigint("owner_user_id", { mode: "number" }).references(() => users.id),
  requestedByUserId: bigint("requested_by_user_id", { mode: "number" }).notNull().references(() => users.id),
  method: pgEnumText("method", ["oauth_invite", "manual_review"]).default("oauth_invite").notNull(),
  status: pgEnumText("status", ["pending", "issued", "completed", "cancelled"]).default("pending").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("access_recovery_tenant_status_idx").on(table.tenantId, table.status),
]);

export const auditLogs = pgTable("audit_logs", {
  id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
  tenantId: bigint("tenant_id", { mode: "number" }).notNull().references(() => tenants.id),
  siteId: bigint("site_id", { mode: "number" }).notNull().references(() => sites.id),
  userId: bigint("user_id", { mode: "number" }).references(() => users.id),
  actorPlatformRole: pgEnumText("actor_platform_role", ["platform_owner", "platform_admin", "finance_admin"]),
  actorTenantRole: varchar("actor_tenant_role", { length: 32 }),
  entityType: varchar("entity_type", { length: 80 }).notNull(),
  entityId: varchar("entity_id", { length: 80 }).notNull(),
  action: varchar("action", { length: 80 }).notNull(),
  beforeData: jsonb("before_data"),
  afterData: jsonb("after_data"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("audit_tenant_site_date_idx").on(table.tenantId, table.siteId, table.createdAt),
  index("audit_entity_idx").on(table.entityType, table.entityId),
  index("audit_user_date_idx").on(table.userId, table.createdAt),
]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
