import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, generators, notificationMessages, platformSecurityEvents, platformSecuritySettings, sites, staffProfiles, tenantMembers, tenantOwnerProfiles, tenantSubscriptions, tenants, users } from "../drizzle/schema";
import { adminRouter } from "./admin";
import { getDb } from "./db";

const enabled = process.env.RUN_ADMIN_INTEGRATION_TESTS === "1";
const testIfEnabled = enabled ? it : it.skip;
const suffix = `platform-admin-${Date.now()}`;
let adminUserId: number | undefined;
let ownerUserId: number | undefined;
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
  });

  testIfEnabled("creates an isolated generator-owner tenant, subscription, and first site", async () => {
    const db = await getDb();
    if (!db || !adminUserId || !ownerUserId) throw new Error("Test setup unavailable");
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
  });

  afterAll(async () => {
    if (!enabled || !tenantId || !siteId || !adminUserId || !ownerUserId) return;
    const db = await getDb();
    if (!db) return;
    await db.delete(notificationMessages).where(eq(notificationMessages.tenantId, tenantId));
    await db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await db.delete(generators).where(eq(generators.siteId, siteId));
    await db.delete(staffProfiles).where(eq(staffProfiles.siteId, siteId));
    await db.delete(sites).where(eq(sites.id, siteId));
    await db.delete(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.tenantId, tenantId));
    await db.delete(tenantSubscriptions).where(eq(tenantSubscriptions.tenantId, tenantId));
    await db.delete(tenantMembers).where(eq(tenantMembers.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await db.delete(platformSecurityEvents).where(eq(platformSecurityEvents.createdByUserId, adminUserId));
    await db.delete(platformSecuritySettings).where(eq(platformSecuritySettings.updatedByUserId, adminUserId));
    await db.delete(users).where(eq(users.id, ownerUserId));
    await db.delete(users).where(eq(users.id, adminUserId));
  });
});
