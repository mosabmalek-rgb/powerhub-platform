import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accessRecoveryRequests, auditLogs, complaints, generators, notificationMessages, platformRolePolicies, platformSecurityEvents, platformSecuritySettings, platformSettings, platformTariffPolicies, sites, staffProfiles, tenantMembers, tenantOwnerProfiles, tenantSubscriptions, tenants, users } from "../drizzle/schema";
import { adminRouter } from "./admin";
import { getDb } from "./db";
import { powerhubRouter } from "./powerhub";

const enabled = process.env.RUN_ADMIN_INTEGRATION_TESTS === "1";
const testIfEnabled = enabled ? it : it.skip;
const suffix = `platform-admin-${Date.now()}`;
let adminUserId: number | undefined;
let ownerUserId: number | undefined;
let managerUserId: number | undefined;
let tenantId: number | undefined;
let siteId: number | undefined;

function insertId(result: unknown) {
  const header = Array.isArray(result) ? result[0] : result;
  return Number((header as { insertId: number }).insertId);
}

describe("platform administration integration", () => {
  beforeAll(async () => {
    if (!enabled) return;
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    adminUserId = insertId(await db.insert(users).values({ openId: `${suffix}-admin`, name: "Platform Admin", role: "admin" }));
    ownerUserId = insertId(await db.insert(users).values({ openId: `${suffix}-owner`, name: "Generator Owner", role: "user" }));
    managerUserId = insertId(await db.insert(users).values({ openId: `${suffix}-manager`, name: "Site Manager", role: "user" }));
  });

  testIfEnabled("creates an isolated generator-owner tenant, subscription, and first site", async () => {
    const db = await getDb();
    if (!db || !adminUserId || !ownerUserId || !managerUserId) throw new Error("Test setup unavailable");
    const [admin] = await db.select().from(users).where(eq(users.id, adminUserId));
    const caller = adminRouter.createCaller({ user: admin, req: {} as never, res: {} as never });
    const created = await caller.createGeneratorOwner({
      tenantName: "مالك مولد تكاملي",
      slug: `${suffix}-tenant`,
      ownerName: "صاحب المولد التكاملي",
      ownerPhone: "0790000000",
      ownerEmail: "owner@example.com",
      ownerUserId,
      siteName: "محطة اختبار الإدارة",
      siteCode: `${suffix}-site`,
      city: "بغداد",
      plan: "professional",
      subscriptionStatus: "trial",
      billingCycle: "monthly",
      autoRenew: true,
    });
    tenantId = created.tenantId;
    siteId = created.siteId;
    await db.insert(staffProfiles).values({ userId: managerUserId, siteId: created.siteId, role: "manager", isActive: true });
    const [profile] = await db.select().from(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.tenantId, created.tenantId));
    const [subscription] = await db.select().from(tenantSubscriptions).where(eq(tenantSubscriptions.tenantId, created.tenantId));
    const [membership] = await db.select().from(tenantMembers).where(eq(tenantMembers.tenantId, created.tenantId));
    expect(profile).toMatchObject({ ownerUserId, fullName: "صاحب المولد التكاملي" });
    expect(subscription).toMatchObject({ plan: "professional", status: "trial", billingCycle: "monthly", autoRenew: true });
    expect(membership).toMatchObject({ userId: ownerUserId, role: "owner" });
    await expect(caller.renewSubscription({ tenantId: created.tenantId, periods: 2 })).resolves.toMatchObject({ endsAt: expect.any(Date) });
    const [renewed] = await db.select().from(tenantSubscriptions).where(eq(tenantSubscriptions.tenantId, created.tenantId));
    expect(renewed).toMatchObject({ status: "active", renewalCount: 2 });
    const generatorId = insertId(await db.insert(generators).values({ tenantId: created.tenantId, siteId: created.siteId, code: `${suffix}-gen`, name: "مولد اختبار الحظر", ratedCapacityKw: "100", status: "active" }));
    await caller.setGeneratorStatus({ id: generatorId, status: "blocked" });
    const [blockedGenerator] = await db.select().from(generators).where(eq(generators.id, generatorId));
    expect(blockedGenerator.status).toBe("blocked");
    const generatorDetails = await caller.generatorDetails({ generatorId });
    expect(generatorDetails.generator).toMatchObject({ id: generatorId, status: "blocked", ratedCapacityKw: "100.000" });
    expect(generatorDetails.subscriberSummary.total).toBeGreaterThanOrEqual(0);
    await db.insert(notificationMessages).values({ tenantId: created.tenantId, channel: "whatsapp", eventType: "service_alert", recipient: "0790000000", status: "pending", payload: { source: "admin-integration" } });
    await caller.recordSecurityEvent({ eventType: "backup", severity: "info", status: "success", title: "نسخة اختبار", details: "اكتمل اختبار سجل النسخ" });
    await caller.saveSecuritySetting({ settingKey: `${suffix}-audit-guard`, isEnabled: true });
    const security = await caller.securityCenter();
    expect(security.events.some((event) => event.title === "نسخة اختبار")).toBe(true);
    expect(security.settings.some((setting) => setting.settingKey === `${suffix}-audit-guard` && setting.isEnabled)).toBe(true);
    const snapshot = await caller.platformSnapshot();
    expect(snapshot.generators.directory.some((item) => item.id === generatorId && item.status === "blocked")).toBe(true);
    expect(snapshot.users.staffDirectory.some((item) => item.userName === "Generator Owner" && item.role === "owner")).toBe(true);
    const notificationLedger = await caller.listNotifications();
    expect(notificationLedger.some((item) => item.tenantName === "مالك مولد تكاملي" && item.eventType === "service_alert")).toBe(true);
    const complaintId = insertId(await db.insert(complaints).values({ tenantId: created.tenantId, siteId: created.siteId, title: "شكوى تكاملية", description: "اختبار مسار الشكاوى", priority: "high" }));
    await caller.updateComplaint({ id: complaintId, status: "resolved", response: "تمت المعالجة" });
    const tariffResult = await caller.createTariffPolicy({ minimumPricePerKwh: 20, maximumPricePerKwh: 40, effectiveFrom: new Date(), notificationRequested: true });
    expect(tariffResult.queuedNotifications).toBeGreaterThan(0);
    const tariffNotifications = await caller.listNotifications();
    expect(tariffNotifications.filter((item) => item.eventType === "service_alert" && item.tenantName === "مالك مولد تكاملي").length).toBeGreaterThanOrEqual(2);
    await caller.savePlatformSetting({ settingKey: `${suffix}-maintenance`, isEnabled: true, message: "صيانة اختبارية" });
    await caller.savePlatformSetting({ settingKey: "maintenance_mode", isEnabled: true, message: "صيانة تكاملية" });
    const [ownerUser] = await db.select().from(users).where(eq(users.id, ownerUserId));
    const ownerCaller = powerhubRouter.createCaller({ user: ownerUser, req: {} as never, res: {} as never });
    await expect(ownerCaller.sites.list()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await caller.savePlatformSetting({ settingKey: "maintenance_mode", isEnabled: false, message: "" });
    await caller.requestOwnerAccessRecovery({ tenantId: created.tenantId, note: "طلب اختبار" });
    await caller.savePlatformSetting({ settingKey: "public_invoice_options", isEnabled: true, message: "رسالة رابط اختبار", value: { showPlatformBranding: true, showSupportText: false } });
    const dashboard = await caller.advancedDashboard();
    expect(dashboard.kpis.subscribers).toBeGreaterThanOrEqual(0);
    expect(dashboard.latestGenerators.some((item) => item.id === generatorId)).toBe(true);
    const search = await caller.globalSearch({ query: "مولد اختبار" });
    expect(search.some((item) => item.kind === "generator" && item.id === generatorId)).toBe(true);
    const listedComplaints = await caller.listComplaints();
    expect(listedComplaints.some((item) => item.id === complaintId && item.status === "resolved")).toBe(true);
    const configuration = await caller.platformConfiguration();
    expect(configuration.recoveries.some((item) => item.tenantName === "مالك مولد تكاملي")).toBe(true);
    expect(configuration.settings.some((item) => item.settingKey === "public_invoice_options" && item.isEnabled)).toBe(true);
    await caller.setTenantStatus({ tenantId: created.tenantId, status: "suspended" });
    const [suspendedTenant] = await db.select().from(tenants).where(eq(tenants.id, created.tenantId));
    expect(suspendedTenant.status).toBe("suspended");
    await caller.setTenantStatus({ tenantId: created.tenantId, status: "active" });
    await caller.saveRolePolicy({ role: "manager", capability: "manageGenerators", isAllowed: false });
    const [manager] = await db.select().from(users).where(eq(users.id, managerUserId));
    const managerCaller = powerhubRouter.createCaller({ user: manager, req: {} as never, res: {} as never });
    await expect(managerCaller.generators.create({ siteId: created.siteId, code: `${suffix}-blocked-by-policy`, name: "مولد ممنوع", ratedCapacityKw: "50", fuelType: "diesel" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller.saveRolePolicy({ role: "manager", capability: "manageTeam", isAllowed: false });
    await expect(managerCaller.staff.list({ siteId: created.siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller.saveRolePolicy({ role: "manager", capability: "manageExpenses", isAllowed: false });
    await expect(managerCaller.expenses.create({ siteId: created.siteId, category: "fuel", description: "مصروف ممنوع بالسياسة", amount: 25 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller.saveRolePolicy({ role: "manager", capability: "viewAudit", isAllowed: false });
    await expect(managerCaller.audit.list({ siteId: created.siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller.saveRolePolicy({ role: "owner", capability: "manageMessaging", isAllowed: false });
    await expect(ownerCaller.messaging.listConfigurations({ siteId: created.siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const policies = await caller.rolePolicies();
    expect(policies.some((policy) => policy.role === "manager" && policy.capability === "manageGenerators" && !policy.isAllowed)).toBe(true);
    expect(policies.some((policy) => policy.role === "manager" && policy.capability === "manageTeam" && !policy.isAllowed)).toBe(true);
    expect(policies.some((policy) => policy.role === "manager" && policy.capability === "manageExpenses" && !policy.isAllowed)).toBe(true);
    expect(policies.some((policy) => policy.role === "manager" && policy.capability === "viewAudit" && !policy.isAllowed)).toBe(true);
    expect(policies.some((policy) => policy.role === "owner" && policy.capability === "manageMessaging" && !policy.isAllowed)).toBe(true);
    await expect(caller.impersonationStatus()).resolves.toMatchObject({ enabled: false, confirmationRequired: true });
  });

  afterAll(async () => {
    if (!enabled || !tenantId || !siteId || !adminUserId || !ownerUserId || !managerUserId) return;
    const db = await getDb();
    if (!db) return;
    await db.delete(complaints).where(eq(complaints.tenantId, tenantId));
    await db.delete(notificationMessages).where(eq(notificationMessages.tenantId, tenantId));
    await db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await db.delete(generators).where(eq(generators.siteId, siteId));
    await db.delete(staffProfiles).where(eq(staffProfiles.siteId, siteId));
    await db.delete(sites).where(eq(sites.id, siteId));
    await db.delete(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.tenantId, tenantId));
    await db.delete(tenantSubscriptions).where(eq(tenantSubscriptions.tenantId, tenantId));
    await db.delete(tenantMembers).where(eq(tenantMembers.tenantId, tenantId));
    await db.delete(accessRecoveryRequests).where(eq(accessRecoveryRequests.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await db.delete(platformSecurityEvents).where(eq(platformSecurityEvents.createdByUserId, adminUserId));
    await db.delete(platformSecuritySettings).where(eq(platformSecuritySettings.updatedByUserId, adminUserId));
    await db.delete(platformTariffPolicies).where(eq(platformTariffPolicies.createdByUserId, adminUserId));
    await db.delete(platformSettings).where(eq(platformSettings.updatedByUserId, adminUserId));
    await db.delete(platformRolePolicies).where(eq(platformRolePolicies.updatedByUserId, adminUserId));
    await db.delete(users).where(eq(users.id, ownerUserId));
    await db.delete(users).where(eq(users.id, managerUserId));
    await db.delete(users).where(eq(users.id, adminUserId));
  });
});
