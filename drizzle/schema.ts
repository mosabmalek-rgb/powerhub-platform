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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

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
  email: varchar("email", { length: 320 }),
  companyName: varchar("companyName", { length: 180 }),
  invitedAt: timestamp("invitedAt"),
  claimedAt: timestamp("claimedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_owner_profile_tenant_unique").on(table.tenantId),
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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_subscription_tenant_unique").on(table.tenantId),
  index("tenant_subscription_status_end_idx").on(table.status, table.endsAt),
]);

export const tenantMembers = mysqlTable("tenantMembers", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  userId: int("userId").notNull().references(() => users.id),
  role: mysqlEnum("role", ["owner", "admin", "member"]).default("member").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
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
  credentialCiphertext: text("credentialCiphertext"),
  credentialIv: varchar("credentialIv", { length: 64 }),
  credentialKeyVersion: int("credentialKeyVersion").default(1).notNull(),
  webhookVerifyTokenHash: varchar("webhookVerifyTokenHash", { length: 128 }),
  isActive: boolean("isActive").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("tenant_channel_unique").on(table.tenantId, table.channel),
]);

export const sites = mysqlTable("sites", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  name: varchar("name", { length: 160 }).notNull(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  city: varchar("city", { length: 100 }),
  address: text("address"),
  status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const staffProfiles = mysqlTable("staffProfiles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().references(() => users.id),
  siteId: int("siteId").references(() => sites.id),
  role: mysqlEnum("role", ["owner", "manager", "accountant", "collector", "technician", "viewer"]).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("staff_user_site_role_unique").on(table.userId, table.siteId, table.role),
]);

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
  status: mysqlEnum("status", ["active", "maintenance", "stopped", "offline", "blocked"]).default("stopped").notNull(),
  lastMaintenanceAt: timestamp("lastMaintenanceAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("generator_site_code_unique").on(table.siteId, table.code),
  index("generators_tenant_site_idx").on(table.tenantId, table.siteId),
  index("generators_site_status_idx").on(table.siteId, table.status),
]);

export const subscribers = mysqlTable("subscribers", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  subscriberNo: varchar("subscriberNo", { length: 50 }).notNull(),
  fullName: varchar("fullName", { length: 180 }).notNull(),
  phone: varchar("phone", { length: 30 }).notNull(),
  address: text("address"),
  subscriptionType: mysqlEnum("subscriptionType", ["residential", "commercial"]).default("residential").notNull(),
  serviceStatus: mysqlEnum("serviceStatus", ["active", "suspended", "disconnected"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("subscriber_site_number_unique").on(table.siteId, table.subscriberNo),
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
  meterId: int("meterId").notNull().references(() => meters.id),
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
  index("readings_meter_date_idx").on(table.meterId, table.readingAt),
  index("readings_status_idx").on(table.status),
]);

export const invoices = mysqlTable("invoices", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  subscriberId: int("subscriberId").notNull().references(() => subscribers.id),
  meterId: int("meterId").notNull().references(() => meters.id),
  readingId: int("readingId").references(() => meterReadings.id),
  tariffId: int("tariffId").references(() => tariffs.id),
  invoiceNo: varchar("invoiceNo", { length: 60 }).notNull().unique(),
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
  uniqueIndex("invoice_meter_period_unique").on(table.meterId, table.billingPeriod),
  index("invoices_tenant_site_idx").on(table.tenantId, table.siteId),
  index("invoices_site_status_idx").on(table.siteId, table.status),
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
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  paymentMethod: mysqlEnum("paymentMethod", ["cash", "wallet", "bank_transfer", "card"]).default("cash").notNull(),
  referenceNo: varchar("referenceNo", { length: 120 }),
  status: mysqlEnum("status", ["pending", "completed", "cancelled", "refunded"]).default("completed").notNull(),
  collectedByUserId: int("collectedByUserId").references(() => users.id),
  collectorSessionId: int("collectorSessionId").references(() => collectorSessions.id),
  paidAt: timestamp("paidAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("payments_tenant_site_idx").on(table.tenantId, table.siteId),
  index("payments_site_date_idx").on(table.siteId, table.paidAt),
]);

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
  eventType: mysqlEnum("eventType", ["invoice_issued", "payment_reminder", "payment_received", "service_alert"]).notNull(),
  recipient: varchar("recipient", { length: 50 }).notNull(),
  status: mysqlEnum("status", ["pending", "submitted", "delivered", "read", "failed"]).default("pending").notNull(),
  providerMessageId: varchar("providerMessageId", { length: 200 }),
  payload: json("payload"),
  attempts: int("attempts").default(0).notNull(),
  lastError: text("lastError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

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

export const auditLogs = mysqlTable("auditLogs", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull().references(() => tenants.id),
  siteId: int("siteId").notNull().references(() => sites.id),
  userId: int("userId").references(() => users.id),
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
