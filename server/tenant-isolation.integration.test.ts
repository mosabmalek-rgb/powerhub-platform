import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { meterReadings, meters, sites, staffProfiles, subscribers, tenantMembers, tenants, users } from "../drizzle/schema";
import { getDb } from "./db";
import { powerhubRouter } from "./powerhub";

const runDatabaseIsolationTest = process.env.RUN_TENANT_ISOLATION_TESTS === "1";
const testIfEnabled = runDatabaseIsolationTest ? it : it.skip;
const suffix = `isolation-${Date.now()}`;
let ids: { userA: number; userB: number; userManager: number; tenantA: number; tenantB: number; siteA: number; siteA2: number; siteB: number; subscriberB: number; meterB: number; readingB: number };

function insertId(result: unknown) {
  const header = Array.isArray(result) ? result[0] : result;
  return Number((header as { insertId: number }).insertId);
}

describe("tenant isolation", () => {
  beforeAll(async () => {
    if (!runDatabaseIsolationTest) return;
    const db = await getDb();
    if (!db) throw new Error("Database must be available for the tenant isolation integration test.");
    const userA = insertId(await db.insert(users).values({ openId: `${suffix}-a`, name: "Owner A", role: "user" }));
    const userB = insertId(await db.insert(users).values({ openId: `${suffix}-b`, name: "Owner B", role: "user" }));
    const userManager = insertId(await db.insert(users).values({ openId: `${suffix}-manager`, name: "Manager A", role: "user" }));
    const tenantA = insertId(await db.insert(tenants).values({ name: "Tenant A", slug: `${suffix}-a` }));
    const tenantB = insertId(await db.insert(tenants).values({ name: "Tenant B", slug: `${suffix}-b` }));
    await db.insert(tenantMembers).values([{ tenantId: tenantA, userId: userA, role: "owner" }, { tenantId: tenantA, userId: userManager, role: "member" }, { tenantId: tenantB, userId: userB, role: "owner" }]);
    const siteA = insertId(await db.insert(sites).values({ tenantId: tenantA, name: "Site A", code: `${suffix}-a`.toUpperCase() }));
    const siteA2 = insertId(await db.insert(sites).values({ tenantId: tenantA, name: "Site A2", code: `${suffix}-a2`.toUpperCase() }));
    const siteB = insertId(await db.insert(sites).values({ tenantId: tenantB, name: "Site B", code: `${suffix}-b`.toUpperCase() }));
    await db.insert(staffProfiles).values({ siteId: siteA, userId: userManager, role: "manager" });
    const subscriberB = insertId(await db.insert(subscribers).values({ tenantId: tenantB, siteId: siteB, subscriberNo: suffix, fullName: "Subscriber B", phone: "700000000" }));
    const meterB = insertId(await db.insert(meters).values({ tenantId: tenantB, subscriberId: subscriberB, serialNumber: `${suffix}-meter` }));
    const readingB = insertId(await db.insert(meterReadings).values({ tenantId: tenantB, meterId: meterB, readingValue: "100", status: "approved" }));
    ids = { userA, userB, userManager, tenantA, tenantB, siteA, siteA2, siteB, subscriberB, meterB, readingB };
  });

  testIfEnabled("rejects cross-tenant identifiers and cross-site manager access", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [ownerA] = await db.select().from(users).where(eq(users.id, ids.userA));
    const caller = powerhubRouter.createCaller({ user: ownerA, req: {} as never, res: {} as never });
    await expect(caller.payments.create({ siteId: ids.siteA, subscriberId: ids.subscriberB, paymentNo: `${suffix}-payment`, amount: 10, paymentMethod: "cash" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.invoices.createFromReading({ siteId: ids.siteA, readingId: ids.readingB, tariffId: 999999, billingPeriod: "2026-08", dueDate: new Date("2026-08-31"), discountAmount: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.messaging.listConfigurations({ siteId: ids.siteB })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [manager] = await db.select().from(users).where(eq(users.id, ids.userManager));
    const managerCaller = powerhubRouter.createCaller({ user: manager, req: {} as never, res: {} as never });
    await expect(managerCaller.subscribers.create({ siteId: ids.siteA2, subscriberNo: `${suffix}-cross-site`, fullName: "Cross Site", phone: "700000001", subscriptionType: "residential" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  afterAll(async () => {
    if (!runDatabaseIsolationTest || !ids) return;
    const db = await getDb();
    if (!db) return;
    await db.delete(meterReadings).where(eq(meterReadings.id, ids.readingB));
    await db.delete(meters).where(eq(meters.id, ids.meterB));
    await db.delete(subscribers).where(eq(subscribers.id, ids.subscriberB));
    await db.delete(staffProfiles).where(eq(staffProfiles.userId, ids.userManager));
    await db.delete(sites).where(inArray(sites.id, [ids.siteA, ids.siteA2, ids.siteB]));
    await db.delete(tenantMembers).where(inArray(tenantMembers.tenantId, [ids.tenantA, ids.tenantB]));
    await db.delete(tenants).where(inArray(tenants.id, [ids.tenantA, ids.tenantB]));
    await db.delete(users).where(inArray(users.id, [ids.userA, ids.userB, ids.userManager]));
  });
});
