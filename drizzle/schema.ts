import {
  boolean,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  platformRole: mysqlEnum("platformRole", ["platform_owner", "platform_admin", "finance_admin"]),
  accountStatus: mysqlEnum("accountStatus", ["active", "locked", "disabled"]).default("active").notNull(),
  mustChangePassword: boolean("mustChangePassword").default(false).notNull(),
  temporaryPasswordIssuedAt: timestamp("temporaryPasswordIssuedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const userQuickActionPreferences = mysqlTable("userQuickActionPreferences", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().references(() => users.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  actionIds: json("actionIds").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("user_quick_actions_user_site_unique").on(table.userId, table.siteId),
  index("user_quick_actions_site_idx").on(table.siteId),
]);

export const mobileApiSessions = mysqlTable("mobileApiSessions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().references(() => users.id),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  refreshTokenHash: varchar("refreshTokenHash", { length: 128 }).notNull().unique(),
  deviceLabel: varchar("deviceLabel", { length: 160 }),
  expiresAt: timestamp("expiresAt").notNull(),
  revokedAt: timestamp("revokedAt"),
  lastUsedAt: timestamp("lastUsedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("mobile_api_sessions_user_tenant_idx").on(table.userId, table.tenantId, table.revokedAt),
  index("mobile_api_sessions_expiry_idx").on(table.expiresAt),
]);

export const mobileSyncEvents = mysqlTable("mobileSyncEvents", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  userId: int("userId").notNull().references(() => users.id),
  sessionId: int("sessionId").references(() => mobileApiSessions.id),
  eventKey: varchar("eventKey", { length: 128 }).notNull(),
  eventType: mysqlEnum("eventType", ["sync_cycle", "sync_error"]).notNull(),
  status: mysqlEnum("status", ["success", "partial", "retryable", "needs_review", "failed"]).notNull(),
  syncedCount: int("syncedCount").default(0).notNull(),
  retryableCount: int("retryableCount").default(0).notNull(),
  needsReviewCount: int("needsReviewCount").default(0).notNull(),
  errorCode: varchar("errorCode", { length: 100 }),
  errorMessage: text("errorMessage"),
  appVersion: varchar("appVersion", { length: 64 }),
  deviceLabel: varchar("deviceLabel", { length: 160 }),
  metadata: json("metadata"),
  occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("mobile_sync_events_tenant_event_key_unique").on(table.tenantId, table.eventKey),
  index("mobile_sync_events_tenant_site_date_idx").on(table.tenantId, table.siteId, table.occurredAt),
  index("mobile_sync_events_tenant_user_date_idx").on(table.tenantId, table.userId, table.occurredAt),
  index("mobile_sync_events_site_status_date_idx").on(table.siteId, table.status, table.occurredAt),
]);

export const tenants = mysqlTable("tenants", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  status: mysqlEnum("status", ["active", "suspended", "archived"]).default("active").notNull(),
  plan: mysqlEnum("plan", ["starter", "professional", "enterprise"]).default("starter").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const tenantOwnerProfiles = mysqlTable("tenantOwnerProfiles", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  ownerUserId: int("ownerUserId").references(() => users.id),
  fullName: varchar("fullName", { length: 180 }).notNull(),
  phone: varchar("phone", { length: 30 }).notNull(),
  whatsappNumber: varchar("whatsappNumber", { length: 30 }),
  email: varchar("email", { length: 320 }),
  companyName: varchar("companyName", { length: 180 }),
  reportLogoKey: varchar("reportLogoKey", { length: 500 }),
  identityNumberCiphertext: text("identityNumberCiphertext"),
  identityNumberIv: varchar("identityNumberIv", { length: 64 }),
  identityNumberLast4: varchar("identityNumberLast4", { length: 4 }),
  invitedAt: timestamp("invitedAt"),
  claimedAt: timestamp("claimedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_owner_profile_tenant_unique").on(table.tenantId),
  uniqueIndex("tenant_owner_profile_phone_unique").on(table.phone),
  uniqueIndex("tenant_owner_profile_email_unique").on(table.email),
  index("tenant_owner_profile_user_idx").on(table.ownerUserId),
]);

export const tenantSubscriptions = mysqlTable("tenantSubscriptions", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  plan: mysqlEnum("plan", ["starter", "professional", "enterprise"]).default("starter").notNull(),
  status: mysqlEnum("status", ["trial", "active", "overdue", "suspended", "cancelled"]).default("trial").notNull(),
  billingCycle: mysqlEnum("billingCycle", ["monthly", "yearly"]).default("monthly").notNull(),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  endsAt: timestamp("endsAt").notNull(),
  autoRenew: boolean("autoRenew").default(false).notNull(),
  renewalCount: int("renewalCount").default(0).notNull(),
  lastRenewedAt: timestamp("lastRenewedAt"),
  notes: text("notes"),
  smsPlanId: int("smsPlanId").references(() => platformSmsPlans.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_subscription_tenant_unique").on(table.tenantId),
  index("tenant_subscription_status_end_idx").on(table.status, table.endsAt),
]);

export const platformSmsPlans = mysqlTable("platformSmsPlans", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 80 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  includedMessages: int("includedMessages").default(0).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const smsPackageRequests = mysqlTable("smsPackageRequests", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  requestedByUserId: int("requestedByUserId").notNull().references(() => users.id),
  requestedMessages: int("requestedMessages").notNull(),
  approvedMessages: int("approvedMessages").default(0).notNull(),
  status: mysqlEnum("status", ["pending", "approved", "rejected", "cancelled"]).default("pending").notNull(),
  note: text("note"),
  reviewedByUserId: int("reviewedByUserId").references(() => users.id),
  reviewedAt: timestamp("reviewedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("sms_package_requests_tenant_status_idx").on(table.tenantId, table.status),
  index("sms_package_requests_status_date_idx").on(table.status, table.createdAt),
]);

export const tenantBranchSettings = mysqlTable("tenantBranchSettings", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  isEnabledOverride: boolean("isEnabledOverride"),
  maxBranchesOverride: int("maxBranchesOverride"),
  disabledBehavior: mysqlEnum("disabledBehavior", ["read_only", "suspended"]).default("read_only").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_branch_settings_tenant_unique").on(table.tenantId),
]);

export const subscriptionUpgradeRequests = mysqlTable("subscriptionUpgradeRequests", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  requestedByUserId: int("requestedByUserId").notNull().references(() => users.id),
  currentPlan: mysqlEnum("currentPlan", ["starter", "professional", "enterprise"]).notNull(),
  requestedPlan: mysqlEnum("requestedPlan", ["starter", "professional", "enterprise"]).notNull(),
  reason: varchar("reason", { length: 80 }).default("subscriber_limit_reached").notNull(),
  status: mysqlEnum("status", ["pending", "reviewing", "approved", "rejected", "cancelled"]).default("pending").notNull(),
  note: text("note"),
  reviewedByUserId: int("reviewedByUserId").references(() => users.id),
  reviewedAt: timestamp("reviewedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("subscription_upgrade_request_tenant_status_idx").on(table.tenantId, table.status),
  index("subscription_upgrade_request_status_date_idx").on(table.status, table.createdAt),
]);

export const tenantMembers = mysqlTable("tenantMembers", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  userId: int("userId").notNull().references(() => users.id),
  role: mysqlEnum("role", ["owner", "admin", "member"]).default("member").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  membershipStatus: mysqlEnum("membershipStatus", ["invited", "active", "suspended", "revoked"]).default("active").notNull(),
  invitedByUserId: int("invitedByUserId").references(() => users.id),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_member_unique").on(table.tenantId, table.userId),
  index("tenant_member_user_idx").on(table.userId, table.isActive),
]);

export const tenantMessagingConfigurations = mysqlTable("tenantMessagingConfigurations", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  channel: mysqlEnum("channel", ["whatsapp", "sms"]).notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  senderId: varchar("senderId", { length: 120 }),
  phoneNumberId: varchar("phoneNumberId", { length: 120 }),
  templateName: varchar("templateName", { length: 120 }),
  receiptTemplateName: varchar("receiptTemplateName", { length: 120 }),
  subscriberReferenceTemplateName: varchar("subscriberReferenceTemplateName", { length: 120 }),
  credentialCiphertext: text("credentialCiphertext"),
  credentialIv: varchar("credentialIv", { length: 64 }),
  credentialKeyVersion: int("credentialKeyVersion").default(1).notNull(),
  webhookVerifyTokenHash: varchar("webhookVerifyTokenHash", { length: 128 }),
  isActive: boolean("isActive").default(false).notNull(),
  autoSendAfterApproval: boolean("autoSendAfterApproval").default(false).notNull(),
  autoSendCron: varchar("autoSendCron", { length: 40 }),
  scheduleCronTaskUid: varchar("scheduleCronTaskUid", { length: 65 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_channel_unique").on(table.tenantId, table.channel),
  index("tenant_messaging_schedule_task_idx").on(table.scheduleCronTaskUid),
]);

export const tenantTweetSmsAccounts = mysqlTable("tenantTweetSmsAccounts", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  apiEndpoint: varchar("apiEndpoint", { length: 500 }),
  credentialCiphertext: text("credentialCiphertext"),
  credentialIv: varchar("credentialIv", { length: 64 }),
  credentialKeyVersion: int("credentialKeyVersion").default(1).notNull(),
  senderName: varchar("senderName", { length: 120 }),
  monthlyLimit: int("monthlyLimit").default(0).notNull(),
  isActive: boolean("isActive").default(false).notNull(),
  lastTestedAt: timestamp("lastTestedAt"),
  lastError: text("lastError"),
  createdByUserId: int("createdByUserId").references(() => users.id),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_tweetsms_account_unique").on(table.tenantId),
  index("tenant_tweetsms_account_active_idx").on(table.isActive),
]);

export const platformTweetSmsAccounts = mysqlTable("platformTweetSmsAccounts", {
  id: int("id").autoincrement().primaryKey(),
  apiEndpoint: varchar("apiEndpoint", { length: 500 }).notNull(),
  credentialCiphertext: text("credentialCiphertext").notNull(),
  credentialIv: varchar("credentialIv", { length: 64 }).notNull(),
  credentialKeyVersion: int("credentialKeyVersion").default(1).notNull(),
  senderName: varchar("senderName", { length: 120 }),
  lowBalanceThreshold: int("lowBalanceThreshold").default(100).notNull(),
  lastProviderBalance: int("lastProviderBalance"),
  lastBalanceCheckedAt: timestamp("lastBalanceCheckedAt"),
  lastTestedAt: timestamp("lastTestedAt"),
  lastError: text("lastError"),
  isActive: boolean("isActive").default(false).notNull(),
  createdByUserId: int("createdByUserId").references(() => users.id),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("platform_tweetsms_account_active_idx").on(table.isActive),
]);

export const platformTweetSmsBalanceAlerts = mysqlTable("platformTweetSmsBalanceAlerts", {
  id: int("id").autoincrement().primaryKey(),
  accountId: int("accountId").notNull().references(() => platformTweetSmsAccounts.id),
  balance: int("balance").notNull(),
  threshold: int("threshold").notNull(),
  status: mysqlEnum("status", ["open", "resolved"]).default("open").notNull(),
  notifiedAt: timestamp("notifiedAt").defaultNow().notNull(),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("platform_tweetsms_alert_account_status_idx").on(table.accountId, table.status),
]);

export const platformSmsFallbackProviders = mysqlTable("platformSmsFallbackProviders", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  providerKey: varchar("providerKey", { length: 80 }).notNull().unique(),
  apiEndpoint: varchar("apiEndpoint", { length: 500 }),
  credentialCiphertext: text("credentialCiphertext"),
  credentialIv: varchar("credentialIv", { length: 64 }),
  credentialKeyVersion: int("credentialKeyVersion").default(1).notNull(),
  senderName: varchar("senderName", { length: 120 }),
  priority: int("priority").default(100).notNull(),
  integrationStatus: mysqlEnum("integrationStatus", ["pending_contract", "ready"]).default("pending_contract").notNull(),
  isActive: boolean("isActive").default(false).notNull(),
  lastTestedAt: timestamp("lastTestedAt"),
  lastError: text("lastError"),
  createdByUserId: int("createdByUserId").references(() => users.id),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("platform_sms_fallback_active_priority_idx").on(table.isActive, table.priority),
]);

export const tenantInvoiceMessageTemplates = mysqlTable("tenantInvoiceMessageTemplates", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  channel: mysqlEnum("channel", ["whatsapp", "sms"]).notNull(),
  eventType: mysqlEnum("eventType", ["invoice_issued"]).default("invoice_issued").notNull(),
  body: text("body").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_invoice_template_unique").on(table.tenantId, table.channel, table.eventType),
]);

export const tenantPaymentReceiptMessageTemplates = mysqlTable("tenantPaymentReceiptMessageTemplates", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  channel: mysqlEnum("channel", ["sms"]).default("sms").notNull(),
  body: text("body").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_payment_receipt_template_unique").on(table.tenantId, table.channel),
]);

export const sites = mysqlTable("sites", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  name: varchar("name", { length: 160 }).notNull(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  city: varchar("city", { length: 100 }),
  address: text("address"),
  status: mysqlEnum("status", ["active", "inactive", "archived"]).default("active").notNull(),
  anomalyAlertPercent: int("anomalyAlertPercent").default(50).notNull(),
  invoiceDueDays: int("invoiceDueDays").default(14).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const sitePortalSettings = mysqlTable("sitePortalSettings", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  portalCode: varchar("portalCode", { length: 50 }).notNull(),
  displayName: varchar("displayName", { length: 160 }),
  primaryColor: varchar("primaryColor", { length: 20 }).default("#0D1117").notNull(),
  accentColor: varchar("accentColor", { length: 20 }).default("#F5B800").notNull(),
  isEnabled: boolean("isEnabled").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("site_portal_settings_site_unique").on(table.siteId),
  uniqueIndex("site_portal_settings_code_unique").on(table.portalCode),
  index("site_portal_settings_tenant_idx").on(table.tenantId),
]);

export const accessInvitations = mysqlTable("accessInvitations", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").references(() => sites.id),
  email: varchar("email", { length: 320 }).notNull(),
  tenantRole: mysqlEnum("tenantRole", ["owner", "admin", "member"]).default("member").notNull(),
  siteRole: mysqlEnum("siteRole", ["owner", "manager", "accountant", "collector", "technician", "viewer"]),
  tokenHash: varchar("tokenHash", { length: 128 }).notNull().unique(),
  status: mysqlEnum("status", ["invited", "accepted", "suspended", "revoked", "expired"]).default("invited").notNull(),
  invitedByUserId: int("invitedByUserId").notNull().references(() => users.id),
  acceptedByUserId: int("acceptedByUserId").references(() => users.id),
  expiresAt: timestamp("expiresAt").notNull(),
  acceptedAt: timestamp("acceptedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("access_invitation_tenant_email_status_idx").on(table.tenantId, table.email, table.status),
  index("access_invitation_email_status_idx").on(table.email, table.status),
]);

export const platformAccessInvitations = mysqlTable("platformAccessInvitations", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  platformRole: mysqlEnum("platformRole", ["platform_owner", "platform_admin", "finance_admin"]).notNull(),
  tokenHash: varchar("tokenHash", { length: 128 }).notNull().unique(),
  status: mysqlEnum("status", ["invited", "accepted", "revoked", "expired"]).default("invited").notNull(),
  invitedByUserId: int("invitedByUserId").notNull().references(() => users.id),
  acceptedByUserId: int("acceptedByUserId").references(() => users.id),
  expiresAt: timestamp("expiresAt").notNull(),
  acceptedAt: timestamp("acceptedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("platform_access_invitation_email_status_idx").on(table.email, table.status),
]);

export const customPermissionRoles = mysqlTable("customPermissionRoles", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  name: varchar("name", { length: 120 }).notNull(),
  description: varchar("description", { length: 255 }),
  permissions: json("permissions").$type<string[]>().notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("custom_permission_role_tenant_name_unique").on(table.tenantId, table.name),
  index("custom_permission_role_tenant_active_idx").on(table.tenantId, table.isActive),
]);

export const staffProfiles = mysqlTable("staffProfiles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().references(() => users.id),
  tenantId: int("tenantId").references(() => tenants.id),
  siteId: int("siteId").references(() => sites.id),
  role: mysqlEnum("role", ["owner", "manager", "accountant", "collector", "technician", "viewer"]).notNull(),
  customRoleId: int("customRoleId").references(() => customPermissionRoles.id),
  permissions: json("permissions").$type<string[] | null>(),
  suspensionStartedAt: timestamp("suspensionStartedAt"),
  suspensionEndsAt: timestamp("suspensionEndsAt"),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("staff_user_site_role_unique").on(table.userId, table.siteId, table.role),
  index("staff_tenant_site_active_idx").on(table.tenantId, table.siteId, table.isActive),
]);

export const employees = mysqlTable("employees", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").references(() => sites.id),
  linkedUserId: int("linkedUserId").references(() => users.id),
  fullName: varchar("fullName", { length: 180 }).notNull(),
  identityNo: varchar("identityNo", { length: 80 }),
  phone: varchar("phone", { length: 40 }),
  jobTitle: mysqlEnum("jobTitle", ["accountant", "collector", "technician", "worker", "supervisor", "other"]).notNull(),
  employmentStatus: mysqlEnum("employmentStatus", ["active", "suspended", "ended"]).default("active").notNull(),
  contractType: mysqlEnum("contractType", ["daily", "monthly", "collection_percentage"]).notNull(),
  baseWage: decimal("baseWage", { precision: 12, scale: 2 }).notNull(),
  hireDate: timestamp("hireDate"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("employees_tenant_status_idx").on(table.tenantId, table.employmentStatus),
  index("employees_tenant_site_idx").on(table.tenantId, table.siteId),
  index("employees_tenant_phone_idx").on(table.tenantId, table.phone),
]);

export const employeeAttendance = mysqlTable("employeeAttendance", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  employeeId: int("employeeId").notNull().references(() => employees.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  workDate: timestamp("workDate").notNull(),
  regularHours: decimal("regularHours", { precision: 5, scale: 2 }).default("0").notNull(),
  overtimeHours: decimal("overtimeHours", { precision: 5, scale: 2 }).default("0").notNull(),
  absentDays: decimal("absentDays", { precision: 4, scale: 2 }).default("0").notNull(),
  notes: varchar("notes", { length: 500 }),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [uniqueIndex("employee_attendance_employee_date_unique").on(table.employeeId, table.workDate), index("employee_attendance_tenant_site_date_idx").on(table.tenantId, table.siteId, table.workDate)]);

export const employeeAdjustments = mysqlTable("employeeAdjustments", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  employeeId: int("employeeId").notNull().references(() => employees.id),
  siteId: int("siteId").references(() => sites.id),
  adjustmentType: mysqlEnum("adjustmentType", ["advance", "deduction"]).notNull(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  remainingAmount: decimal("remainingAmount", { precision: 12, scale: 2 }).notNull(),
  reason: varchar("reason", { length: 255 }).notNull(),
  status: mysqlEnum("status", ["open", "settled", "cancelled"]).default("open").notNull(),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [index("employee_adjustments_tenant_employee_idx").on(table.tenantId, table.employeeId), index("employee_adjustments_tenant_status_idx").on(table.tenantId, table.status)]);

export const payrollRuns = mysqlTable("payrollRuns", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").references(() => sites.id),
  period: varchar("period", { length: 7 }).notNull(),
  status: mysqlEnum("status", ["draft", "approved", "paid", "cancelled"]).default("draft").notNull(),
  totalGross: decimal("totalGross", { precision: 14, scale: 2 }).default("0").notNull(),
  totalDeductions: decimal("totalDeductions", { precision: 14, scale: 2 }).default("0").notNull(),
  totalNet: decimal("totalNet", { precision: 14, scale: 2 }).default("0").notNull(),
  paidFromAccountId: int("paidFromAccountId").references(() => companyAccounts.id),
  approvedByUserId: int("approvedByUserId").references(() => users.id),
  paidAt: timestamp("paidAt"),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [uniqueIndex("payroll_runs_tenant_site_period_unique").on(table.tenantId, table.siteId, table.period), index("payroll_runs_tenant_status_idx").on(table.tenantId, table.status)]);

export const payrollItems = mysqlTable("payrollItems", {
  id: int("id").autoincrement().primaryKey(),
  payrollRunId: int("payrollRunId").notNull().references(() => payrollRuns.id),
  employeeId: int("employeeId").notNull().references(() => employees.id),
  baseAmount: decimal("baseAmount", { precision: 12, scale: 2 }).notNull(),
  extraAmount: decimal("extraAmount", { precision: 12, scale: 2 }).default("0").notNull(),
  advanceDeduction: decimal("advanceDeduction", { precision: 12, scale: 2 }).default("0").notNull(),
  otherDeduction: decimal("otherDeduction", { precision: 12, scale: 2 }).default("0").notNull(),
  netAmount: decimal("netAmount", { precision: 12, scale: 2 }).notNull(),
  notes: text("notes"),
}, (table) => [uniqueIndex("payroll_items_run_employee_unique").on(table.payrollRunId, table.employeeId)]);

export const generators = mysqlTable("generators", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  code: varchar("code", { length: 50 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  serialNumber: varchar("serialNumber", { length: 100 }),
  ratedCapacityKw: decimal("ratedCapacityKw", { precision: 12, scale: 3 }).notNull(),
  fuelType: mysqlEnum("fuelType", ["diesel", "gasoline", "gas", "other"]).default("diesel").notNull(),
  fuelLevelLiters: decimal("fuelLevelLiters", { precision: 12, scale: 2 }).default("0").notNull(),
  operatingHours: decimal("operatingHours", { precision: 12, scale: 2 }).default("0").notNull(),
  status: mysqlEnum("status", ["pending", "active", "maintenance", "stopped", "offline", "blocked"]).default("pending").notNull(),
  lastMaintenanceAt: timestamp("lastMaintenanceAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("generator_site_code_unique").on(table.siteId, table.code),
  uniqueIndex("generator_name_unique").on(table.name),
  index("generators_tenant_site_idx").on(table.tenantId, table.siteId),
  index("generators_site_status_idx").on(table.siteId, table.status),
]);

export const subscribers = mysqlTable("subscribers", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  subscriberNo: varchar("subscriberNo", { length: 50 }).notNull(),
  clientOperationId: varchar("clientOperationId", { length: 80 }),
  fullName: varchar("fullName", { length: 180 }).notNull(),
  phone: varchar("phone", { length: 30 }).notNull(),
  address: text("address"),
  subscriptionType: mysqlEnum("subscriptionType", ["residential", "commercial"]).default("residential").notNull(),
  serviceStatus: mysqlEnum("serviceStatus", ["active", "suspended", "disconnected"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("subscriber_site_number_unique").on(table.siteId, table.subscriberNo),
  uniqueIndex("subscriber_client_operation_unique").on(table.clientOperationId),
  index("subscribers_tenant_site_idx").on(table.tenantId, table.siteId),
  index("subscribers_site_status_idx").on(table.siteId, table.serviceStatus),
]);

export const meters = mysqlTable("meters", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  subscriberId: int("subscriberId").notNull().references(() => subscribers.id),
  generatorId: int("generatorId").references(() => generators.id),
  serialNumber: varchar("serialNumber", { length: 100 }).notNull().unique(),
  meterType: mysqlEnum("meterType", ["manual", "digital", "smart"]).default("manual").notNull(),
  multiplier: decimal("multiplier", { precision: 8, scale: 3 }).default("1").notNull(),
  installedAt: timestamp("installedAt").defaultNow().notNull(),
  status: mysqlEnum("status", ["active", "replaced", "damaged", "offline"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const tariffs = mysqlTable("tariffs", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  name: varchar("name", { length: 160 }).notNull(),
  code: varchar("code", { length: 50 }).notNull(),
  pricePerKwh: decimal("pricePerKwh", { precision: 14, scale: 4 }).notNull(),
  fixedFee: decimal("fixedFee", { precision: 14, scale: 2 }).default("0").notNull(),
  taxRate: decimal("taxRate", { precision: 7, scale: 4 }).default("0").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  effectiveFrom: timestamp("effectiveFrom").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("tariff_site_code_unique").on(table.siteId, table.code),
  index("tariffs_tenant_site_idx").on(table.tenantId, table.siteId),
]);

export const meterReadings = mysqlTable("meterReadings", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  subscriberId: int("subscriberId").notNull().references(() => subscribers.id),
  clientOperationId: varchar("clientOperationId", { length: 80 }).unique(),
  readingAt: timestamp("readingAt").defaultNow().notNull(),
  readingValue: decimal("readingValue", { precision: 15, scale: 3 }).notNull(),
  previousReadingValue: decimal("previousReadingValue", { precision: 15, scale: 3 }),
  consumptionKwh: decimal("consumptionKwh", { precision: 15, scale: 3 }),
  captureMethod: mysqlEnum("captureMethod", ["manual", "photo", "smart_meter"]).default("manual").notNull(),
  imageKey: varchar("imageKey", { length: 500 }),
  imageHash: varchar("imageHash", { length: 128 }),
  status: mysqlEnum("status", ["draft", "pending_review", "approved", "rejected"]).default("pending_review").notNull(),
  enteredByUserId: int("enteredByUserId").references(() => users.id),
  reviewedByUserId: int("reviewedByUserId").references(() => users.id),
  reviewedAt: timestamp("reviewedAt"),
  notes: text("notes"),
  versionNo: int("versionNo").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("readings_subscriber_date_idx").on(table.subscriberId, table.readingAt),
  index("readings_status_idx").on(table.status),
]);

export const invoices = mysqlTable("invoices", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  subscriberId: int("subscriberId").notNull().references(() => subscribers.id),
  readingId: int("readingId").references(() => meterReadings.id),
  tariffId: int("tariffId").references(() => tariffs.id),
  invoiceNo: varchar("invoiceNo", { length: 60 }).notNull().unique(),
  clientOperationId: varchar("clientOperationId", { length: 80 }),
  billingPeriod: varchar("billingPeriod", { length: 7 }).notNull(),
  issueDate: timestamp("issueDate").defaultNow().notNull(),
  dueDate: timestamp("dueDate").notNull(),
  previousReading: decimal("previousReading", { precision: 15, scale: 3 }),
  currentReading: decimal("currentReading", { precision: 15, scale: 3 }),
  consumptionKwh: decimal("consumptionKwh", { precision: 15, scale: 3 }).default("0").notNull(),
  pricePerKwh: decimal("pricePerKwh", { precision: 14, scale: 4 }).default("0").notNull(),
  fixedFee: decimal("fixedFee", { precision: 14, scale: 2 }).default("0").notNull(),
  taxAmount: decimal("taxAmount", { precision: 14, scale: 2 }).default("0").notNull(),
  discountAmount: decimal("discountAmount", { precision: 14, scale: 2 }).default("0").notNull(),
  totalAmount: decimal("totalAmount", { precision: 14, scale: 2 }).default("0").notNull(),
  paidAmount: decimal("paidAmount", { precision: 14, scale: 2 }).default("0").notNull(),
  balanceDue: decimal("balanceDue", { precision: 14, scale: 2 }).default("0").notNull(),
  status: mysqlEnum("status", ["draft", "issued", "partially_paid", "paid", "overdue", "cancelled"]).default("draft").notNull(),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
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
export const offlineSyncOperations = mysqlTable("offlineSyncOperations", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  userId: int("userId").notNull().references(() => users.id),
  clientOperationId: varchar("clientOperationId", { length: 80 }).notNull(),
  operationType: mysqlEnum("operationType", ["subscriber_create", "subscriber_update", "invoice_issue", "payment_create"]).notNull(),
  entityType: varchar("entityType", { length: 80 }).notNull(),
  entityId: int("entityId").notNull(),
  response: json("response").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("offline_sync_actor_operation_unique").on(table.userId, table.clientOperationId),
  index("offline_sync_tenant_site_created_idx").on(table.tenantId, table.siteId, table.createdAt),
]);

export const invoiceLines = mysqlTable("invoiceLines", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  invoiceId: int("invoiceId").notNull().references(() => invoices.id),
  lineType: mysqlEnum("lineType", ["energy", "fixed_fee", "tax", "discount", "late_fee", "other"]).notNull(),
  description: varchar("description", { length: 255 }).notNull(),
  quantity: decimal("quantity", { precision: 15, scale: 3 }).default("1").notNull(),
  unitPrice: decimal("unitPrice", { precision: 14, scale: 4 }).default("0").notNull(),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  displayOrder: int("displayOrder").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("invoice_lines_invoice_idx").on(table.invoiceId, table.displayOrder),
]);

export const invoiceShareLinks = mysqlTable("invoiceShareLinks", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  invoiceId: int("invoiceId").notNull().references(() => invoices.id),
  tokenHash: varchar("tokenHash", { length: 128 }).notNull().unique(),
  tokenPreview: varchar("tokenPreview", { length: 20 }).notNull(),
  expiresAt: timestamp("expiresAt"),
  revokedAt: timestamp("revokedAt"),
  viewCount: int("viewCount").default(0).notNull(),
  lastViewedAt: timestamp("lastViewedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const collectorSessions = mysqlTable("collectorSessions", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  collectorUserId: int("collectorUserId").notNull().references(() => users.id),
  status: mysqlEnum("status", ["open", "closed"]).default("open").notNull(),
  openingCash: decimal("openingCash", { precision: 14, scale: 2 }).default("0").notNull(),
  expectedCash: decimal("expectedCash", { precision: 14, scale: 2 }).default("0").notNull(),
  declaredCash: decimal("declaredCash", { precision: 14, scale: 2 }),
  varianceAmount: decimal("varianceAmount", { precision: 14, scale: 2 }),
  openedAt: timestamp("openedAt").defaultNow().notNull(),
  closedAt: timestamp("closedAt"),
  notes: text("notes"),
  closedByUserId: int("closedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("collector_sessions_tenant_site_idx").on(table.tenantId, table.siteId, table.status),
  index("collector_sessions_collector_status_idx").on(table.collectorUserId, table.status),
]);

export const payments = mysqlTable("payments", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  subscriberId: int("subscriberId").notNull().references(() => subscribers.id),
  invoiceId: int("invoiceId").references(() => invoices.id),
  paymentNo: varchar("paymentNo", { length: 60 }).notNull().unique(),
  clientOperationId: varchar("clientOperationId", { length: 80 }),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  paymentMethod: mysqlEnum("paymentMethod", ["cash", "jawwal_pay", "palpay", "bank_of_palestine", "wallet", "bank_transfer", "card"]).default("cash").notNull(),
  transferFromAccount: varchar("transferFromAccount", { length: 30 }),
  transferFromType: mysqlEnum("transferFromType", ["jawwal_pay", "palpay", "bank_of_palestine"]),
  transferToAccount: varchar("transferToAccount", { length: 30 }),
  transferToType: mysqlEnum("transferToType", ["jawwal_pay", "palpay", "bank_of_palestine"]),
  referenceNo: varchar("referenceNo", { length: 120 }),
  receiptImageKey: varchar("receiptImageKey", { length: 500 }),
  receiptImageHash: varchar("receiptImageHash", { length: 64 }),
  status: mysqlEnum("status", ["pending", "completed", "cancelled", "refunded"]).default("completed").notNull(),
  collectedByUserId: int("collectedByUserId").references(() => users.id),
  collectorSessionId: int("collectorSessionId").references(() => collectorSessions.id),
  paidAt: timestamp("paidAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("payment_client_operation_unique").on(table.clientOperationId),
  index("payments_tenant_site_idx").on(table.tenantId, table.siteId),
  index("payments_site_date_idx").on(table.siteId, table.paidAt),
]);

export const companyAccounts = mysqlTable("companyAccounts", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  name: varchar("name", { length: 120 }).notNull(),
  accountType: mysqlEnum("accountType", ["cash", "jawwal_pay", "palpay", "bank_of_palestine", "other"]).notNull(),
  // يمكن استخدام الرقم نفسه لحسابات من أنواع مختلفة؛ لا يوجد قيد تفرد على phoneNumber.
  phoneNumber: varchar("phoneNumber", { length: 30 }),
  color: varchar("color", { length: 20 }).default("#64748b").notNull(),
  openingBalance: decimal("openingBalance", { precision: 14, scale: 2 }).default("0").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [uniqueIndex("company_accounts_tenant_type_phone_unique").on(table.tenantId, table.accountType, table.phoneNumber), index("company_accounts_tenant_idx").on(table.tenantId)]);

export const companyAccountSites = mysqlTable("companyAccountSites", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  accountId: int("accountId").notNull().references(() => companyAccounts.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [uniqueIndex("company_account_sites_unique").on(table.accountId, table.siteId), index("company_account_sites_tenant_idx").on(table.tenantId)]);

export const accountTransactions = mysqlTable("accountTransactions", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  accountId: int("accountId").notNull().references(() => companyAccounts.id),
  transactionType: mysqlEnum("transactionType", ["deposit", "withdrawal", "transfer_in", "transfer_out", "collection"]).notNull(),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  description: varchar("description", { length: 255 }).notNull(),
  referenceNo: varchar("referenceNo", { length: 120 }),
  relatedPaymentId: int("relatedPaymentId").references(() => payments.id),
  relatedAccountId: int("relatedAccountId").references(() => companyAccounts.id),
  createdByUserId: int("createdByUserId").references(() => users.id),
  occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [index("account_transactions_tenant_account_date_idx").on(table.tenantId, table.accountId, table.occurredAt)]);

export const financialSettlements = mysqlTable("financialSettlements", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  totalCollected: decimal("totalCollected", { precision: 14, scale: 2 }).default("0").notNull(),
  totalExpenses: decimal("totalExpenses", { precision: 14, scale: 2 }).default("0").notNull(),
  bookProfit: decimal("bookProfit", { precision: 14, scale: 2 }).default("0").notNull(),
  actualCash: decimal("actualCash", { precision: 14, scale: 2 }),
  difference: decimal("difference", { precision: 14, scale: 2 }),
  notes: text("notes"),
  status: mysqlEnum("status", ["draft", "submitted", "approved", "locked"]).default("draft").notNull(),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  approvedByUserId: int("approvedByUserId").references(() => users.id),
  lockedAt: timestamp("lockedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [index("financial_settlements_tenant_site_period_idx").on(table.tenantId, table.siteId, table.periodStart, table.periodEnd)]);

export const expenses = mysqlTable("expenses", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  generatorId: int("generatorId").references(() => generators.id),
  category: mysqlEnum("category", ["fuel", "maintenance", "payroll", "parts", "transport", "other"]).notNull(),
  description: varchar("description", { length: 255 }).notNull(),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  referenceNo: varchar("referenceNo", { length: 120 }),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("expenses_tenant_site_idx").on(table.tenantId, table.siteId),
  index("expenses_site_date_idx").on(table.siteId, table.occurredAt),
]);

export const notificationMessages = mysqlTable("notificationMessages", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  invoiceId: int("invoiceId").references(() => invoices.id),
  subscriberId: int("subscriberId").references(() => subscribers.id),
  channel: mysqlEnum("channel", ["whatsapp", "sms"]).notNull(),
  eventType: mysqlEnum("eventType", ["invoice_issued", "payment_reminder", "payment_received", "service_alert", "subscriber_reference"]).notNull(),
  recipient: varchar("recipient", { length: 50 }).notNull(),
  status: mysqlEnum("status", ["pending", "submitted", "delivered", "read", "failed"]).default("pending").notNull(),
  providerMessageId: varchar("providerMessageId", { length: 200 }),
  payload: json("payload"),
  attempts: int("attempts").default(0).notNull(),
  lastError: text("lastError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const messagingScheduleRuns = mysqlTable("messagingScheduleRuns", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  configurationId: int("configurationId").notNull().references(() => tenantMessagingConfigurations.id),
  taskUid: varchar("taskUid", { length: 65 }),
  status: mysqlEnum("status", ["success", "failed"]).default("success").notNull(),
  scanned: int("scanned").default(0).notNull(),
  submitted: int("submitted").default(0).notNull(),
  failed: int("failed").default(0).notNull(),
  skipped: int("skipped").default(0).notNull(),
  error: text("error"),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  finishedAt: timestamp("finishedAt"),
}, (table) => [
  index("messaging_schedule_runs_tenant_date_idx").on(table.tenantId, table.startedAt),
  index("messaging_schedule_runs_config_date_idx").on(table.configurationId, table.startedAt),
]);

export const platformSecurityEvents = mysqlTable("platformSecurityEvents", {
  id: int("id").autoincrement().primaryKey(),
  eventType: mysqlEnum("eventType", ["suspicious_login", "backup", "security_change"]).notNull(),
  severity: mysqlEnum("severity", ["info", "warning", "critical"]).default("info").notNull(),
  status: mysqlEnum("status", ["open", "resolved", "success", "failed"]).default("open").notNull(),
  title: varchar("title", { length: 180 }).notNull(),
  details: text("details"),
  metadata: json("metadata"),
  relatedUserId: int("relatedUserId").references(() => users.id),
  createdByUserId: int("createdByUserId").references(() => users.id),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("platform_security_event_type_date_idx").on(table.eventType, table.createdAt),
  index("platform_security_event_status_idx").on(table.status, table.severity),
]);

export const platformSecuritySettings = mysqlTable("platformSecuritySettings", {
  id: int("id").autoincrement().primaryKey(),
  settingKey: varchar("settingKey", { length: 100 }).notNull(),
  isEnabled: boolean("isEnabled").default(false).notNull(),
  value: text("value"),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("platform_security_setting_key_unique").on(table.settingKey),
]);

export const complaints = mysqlTable("complaints", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  subscriberId: int("subscriberId").references(() => subscribers.id),
  title: varchar("title", { length: 180 }).notNull(),
  description: text("description").notNull(),
  priority: mysqlEnum("priority", ["low", "normal", "high", "urgent"]).default("normal").notNull(),
  status: mysqlEnum("status", ["open", "assigned", "in_progress", "resolved", "closed"]).default("open").notNull(),
  assignedUserId: int("assignedUserId").references(() => users.id),
  response: text("response"),
  openedAt: timestamp("openedAt").defaultNow().notNull(),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("complaints_tenant_site_status_idx").on(table.tenantId, table.siteId, table.status),
  index("complaints_assignee_status_idx").on(table.assignedUserId, table.status),
]);

export const platformTariffPolicies = mysqlTable("platformTariffPolicies", {
  id: int("id").autoincrement().primaryKey(),
  minimumPricePerKwh: decimal("minimumPricePerKwh", { precision: 14, scale: 4 }).notNull(),
  maximumPricePerKwh: decimal("maximumPricePerKwh", { precision: 14, scale: 4 }).notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  notificationRequested: boolean("notificationRequested").default(false).notNull(),
  notes: text("notes"),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("platform_tariff_effective_idx").on(table.effectiveFrom),
]);

export const platformSettings = mysqlTable("platformSettings", {
  id: int("id").autoincrement().primaryKey(),
  settingKey: varchar("settingKey", { length: 100 }).notNull(),
  isEnabled: boolean("isEnabled").default(false).notNull(),
  value: json("value"),
  message: text("message"),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("platform_setting_key_unique").on(table.settingKey),
]);

export const platformRolePolicies = mysqlTable("platformRolePolicies", {
  id: int("id").autoincrement().primaryKey(),
  role: mysqlEnum("role", ["owner", "manager", "accountant", "collector", "technician", "viewer"]).notNull(),
  capability: mysqlEnum("capability", ["manageSubscribers", "manageGenerators", "recordReadings", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"]).notNull(),
  isAllowed: boolean("isAllowed").default(true).notNull(),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("platform_role_capability_unique").on(table.role, table.capability),
  index("platform_role_policy_role_idx").on(table.role),
]);

export const accessRecoveryRequests = mysqlTable("accessRecoveryRequests", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  ownerUserId: int("ownerUserId").references(() => users.id),
  requestedByUserId: int("requestedByUserId").notNull().references(() => users.id),
  method: mysqlEnum("method", ["oauth_invite", "manual_review"]).default("oauth_invite").notNull(),
  status: mysqlEnum("status", ["pending", "issued", "completed", "cancelled"]).default("pending").notNull(),
  note: text("note"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
}, (table) => [
  index("access_recovery_tenant_status_idx").on(table.tenantId, table.status),
]);

export const auditLogs = mysqlTable("auditLogs", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  userId: int("userId").references(() => users.id),
  actorPlatformRole: mysqlEnum("actorPlatformRole", ["platform_owner", "platform_admin", "finance_admin"]),
  actorTenantRole: varchar("actorTenantRole", { length: 32 }),
  entityType: varchar("entityType", { length: 80 }).notNull(),
  entityId: varchar("entityId", { length: 80 }).notNull(),
  action: varchar("action", { length: 80 }).notNull(),
  beforeData: json("beforeData"),
  afterData: json("afterData"),
  metadata: json("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("audit_tenant_site_date_idx").on(table.tenantId, table.siteId, table.createdAt),
  index("audit_entity_idx").on(table.entityType, table.entityId),
  index("audit_user_date_idx").on(table.userId, table.createdAt),
]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
