import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { auditLogs, invoiceLines, invoices, meterReadings, meters, notificationMessages, payments, sites, staffProfiles, subscribers, tariffs, tenantMembers, tenants, users } from "../drizzle/schema";
import { getDb } from "./db";
import { powerhubRouter } from "./powerhub";

const runDatabaseIsolationTest = process.env.RUN_TENANT_ISOLATION_TESTS === "1";
const testIfEnabled = runDatabaseIsolationTest ? it : it.skip;
const suffix = `isolation-${Date.now()}`;
let ids: { userA: number; userB: number; userManager: number; userAccountant: number; userCollector: number; userTechnician: number; userViewer: number; tenantA: number; tenantB: number; siteA: number; siteA2: number; siteB: number; subscriberA: number; meterA: number; baseReadingA: number; tariffA: number; subscriberB: number; meterB: number; readingB: number };
const createdPaymentIds: number[] = [];
let createdReadingA: number | undefined;
const createdSubscriberIds: number[] = [];
let createdInvoiceId: number | undefined;

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
    const userAccountant = insertId(await db.insert(users).values({ openId: `${suffix}-accountant`, name: "Accountant A", role: "user" }));
    const userCollector = insertId(await db.insert(users).values({ openId: `${suffix}-collector`, name: "Collector A", role: "user" }));
    const userTechnician = insertId(await db.insert(users).values({ openId: `${suffix}-technician`, name: "Technician A", role: "user" }));
    const userViewer = insertId(await db.insert(users).values({ openId: `${suffix}-viewer`, name: "Viewer A", role: "user" }));
    const tenantA = insertId(await db.insert(tenants).values({ name: "Tenant A", slug: `${suffix}-a` }));
    const tenantB = insertId(await db.insert(tenants).values({ name: "Tenant B", slug: `${suffix}-b` }));
    await db.insert(tenantMembers).values([{ tenantId: tenantA, userId: userA, role: "owner" }, { tenantId: tenantA, userId: userManager, role: "member" }, { tenantId: tenantA, userId: userAccountant, role: "member" }, { tenantId: tenantA, userId: userCollector, role: "member" }, { tenantId: tenantA, userId: userTechnician, role: "member" }, { tenantId: tenantA, userId: userViewer, role: "member" }, { tenantId: tenantB, userId: userB, role: "owner" }]);
    const siteA = insertId(await db.insert(sites).values({ tenantId: tenantA, name: "Site A", code: `${suffix}-a`.toUpperCase() }));
    const siteA2 = insertId(await db.insert(sites).values({ tenantId: tenantA, name: "Site A2", code: `${suffix}-a2`.toUpperCase() }));
    const siteB = insertId(await db.insert(sites).values({ tenantId: tenantB, name: "Site B", code: `${suffix}-b`.toUpperCase() }));
    await db.insert(staffProfiles).values([{ siteId: siteA, userId: userManager, role: "manager" }, { siteId: siteA, userId: userAccountant, role: "accountant" }, { siteId: siteA, userId: userCollector, role: "collector" }, { siteId: siteA, userId: userTechnician, role: "technician" }, { siteId: siteA, userId: userViewer, role: "viewer" }]);
    const subscriberA = insertId(await db.insert(subscribers).values({ tenantId: tenantA, siteId: siteA, subscriberNo: `${suffix}-a`, fullName: "Subscriber A", phone: "700000010" }));
    const meterA = insertId(await db.insert(meters).values({ tenantId: tenantA, subscriberId: subscriberA, serialNumber: `${suffix}-meter-a` }));
    const baseReadingA = insertId(await db.insert(meterReadings).values({ tenantId: tenantA, meterId: meterA, readingValue: "10", status: "approved" }));
    const tariffA = insertId(await db.insert(tariffs).values({ tenantId: tenantA, siteId: siteA, name: "Tariff A", code: `${suffix}-tariff`, pricePerKwh: "1.5", fixedFee: "2", taxRate: "0" }));
    const subscriberB = insertId(await db.insert(subscribers).values({ tenantId: tenantB, siteId: siteB, subscriberNo: suffix, fullName: "Subscriber B", phone: "700000000" }));
    const meterB = insertId(await db.insert(meters).values({ tenantId: tenantB, subscriberId: subscriberB, serialNumber: `${suffix}-meter` }));
    const readingB = insertId(await db.insert(meterReadings).values({ tenantId: tenantB, meterId: meterB, readingValue: "100", status: "approved" }));
    ids = { userA, userB, userManager, userAccountant, userCollector, userTechnician, userViewer, tenantA, tenantB, siteA, siteA2, siteB, subscriberA, meterA, baseReadingA, tariffA, subscriberB, meterB, readingB };
  });

  testIfEnabled("rejects cross-tenant identifiers and cross-site manager access", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [ownerA] = await db.select().from(users).where(eq(users.id, ids.userA));
    const caller = powerhubRouter.createCaller({ user: ownerA, req: {} as never, res: {} as never });
    await expect(caller.staff.myAccess({ siteId: ids.siteA })).resolves.toEqual({ role: "owner" });
    const ownerSubscriber = await caller.subscribers.create({ siteId: ids.siteA, subscriberNo: `${suffix}-owner-site`, fullName: "Owner Site", phone: "700000003", subscriptionType: "residential" });
    createdSubscriberIds.push(ownerSubscriber.id);
    await expect(caller.payments.create({ siteId: ids.siteA, subscriberId: ids.subscriberB, paymentNo: `${suffix}-payment`, amount: 10, paymentMethod: "cash" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.invoices.createFromReading({ siteId: ids.siteA, readingId: ids.readingB, tariffId: 999999, billingPeriod: "2026-08", dueDate: new Date("2026-08-31"), discountAmount: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.messaging.listConfigurations({ siteId: ids.siteB })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [manager] = await db.select().from(users).where(eq(users.id, ids.userManager));
    const managerCaller = powerhubRouter.createCaller({ user: manager, req: {} as never, res: {} as never });
    await expect(managerCaller.subscribers.create({ siteId: ids.siteA2, subscriberNo: `${suffix}-cross-site`, fullName: "Cross Site", phone: "700000001", subscriptionType: "residential" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const managerSubscriber = await managerCaller.subscribers.create({ siteId: ids.siteA, subscriberNo: `${suffix}-manager-site`, fullName: "Manager Site", phone: "700000002", subscriptionType: "residential" });
    createdSubscriberIds.push(managerSubscriber.id);
  });

  testIfEnabled("enforces accountant, collector, technician, and viewer boundaries", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const selectUser = async (id: number) => (await db.select().from(users).where(eq(users.id, id)))[0];
    const accountant = powerhubRouter.createCaller({ user: await selectUser(ids.userAccountant), req: {} as never, res: {} as never });
    const collector = powerhubRouter.createCaller({ user: await selectUser(ids.userCollector), req: {} as never, res: {} as never });
    const technician = powerhubRouter.createCaller({ user: await selectUser(ids.userTechnician), req: {} as never, res: {} as never });
    const viewer = powerhubRouter.createCaller({ user: await selectUser(ids.userViewer), req: {} as never, res: {} as never });
    const accountantSubscriber = await accountant.subscribers.create({ siteId: ids.siteA, subscriberNo: `${suffix}-accountant-site`, fullName: "Accountant Site", phone: "700000004", subscriptionType: "commercial" });
    createdSubscriberIds.push(accountantSubscriber.id);
    const accountantPayment = await accountant.payments.create({ siteId: ids.siteA, subscriberId: ids.subscriberA, paymentNo: `${suffix}-accountant`, amount: 1, paymentMethod: "cash" });
    const collectorPayment = await collector.payments.create({ siteId: ids.siteA, subscriberId: ids.subscriberA, paymentNo: `${suffix}-collector`, amount: 1, paymentMethod: "cash" });
    createdPaymentIds.push(accountantPayment.id, collectorPayment.id);
    const reading = await technician.readings.create({ siteId: ids.siteA, meterId: ids.meterA, readingValue: "12", captureMethod: "manual" });
    createdReadingA = reading.id;
    await expect(technician.payments.create({ siteId: ids.siteA, subscriberId: ids.subscriberA, paymentNo: `${suffix}-technician`, amount: 1, paymentMethod: "cash" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(collector.readings.create({ siteId: ids.siteA, meterId: ids.meterA, readingValue: "13", captureMethod: "manual" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewer.readings.create({ siteId: ids.siteA, meterId: ids.meterA, readingValue: "13", captureMethod: "manual" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewer.payments.create({ siteId: ids.siteA, subscriberId: ids.subscriberA, paymentNo: `${suffix}-viewer`, amount: 1, paymentMethod: "cash" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  testIfEnabled("replays one offline operation without duplicating its meter reading", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [owner] = await db.select().from(users).where(eq(users.id, ids.userA));
    const ownerCaller = powerhubRouter.createCaller({ user: owner, req: {} as never, res: {} as never });
    const clientOperationId = crypto.randomUUID();
    const input = { siteId: ids.siteA, meterId: ids.meterA, readingValue: "15", captureMethod: "manual" as const, clientOperationId };
    const first = await ownerCaller.readings.create(input);
    const second = await ownerCaller.readings.create(input);
    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);
    await expect(ownerCaller.readings.create({ ...input, clientOperationId: crypto.randomUUID(), readingValue: "5" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  testIfEnabled("creates invoice lines and queues the tenant notification", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [owner] = await db.select().from(users).where(eq(users.id, ids.userA));
    const ownerCaller = powerhubRouter.createCaller({ user: owner, req: {} as never, res: {} as never });
    const invoice = await ownerCaller.invoices.createFromReading({ siteId: ids.siteA, readingId: ids.baseReadingA, tariffId: ids.tariffA, billingPeriod: "2026-08", dueDate: new Date("2026-08-31"), discountAmount: 0 });
    createdInvoiceId = invoice.id;
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id));
    const [notification] = await db.select().from(notificationMessages).where(eq(notificationMessages.invoiceId, invoice.id));
    expect(lines).toHaveLength(3);
    expect(notification).toMatchObject({ tenantId: ids.tenantA, channel: "whatsapp", eventType: "invoice_issued", status: "pending" });
  });

  afterAll(async () => {
    if (!runDatabaseIsolationTest || !ids) return;
    const db = await getDb();
    if (!db) return;
    if (createdPaymentIds.length) await db.delete(payments).where(inArray(payments.id, createdPaymentIds));
    if (createdInvoiceId) {
      await db.delete(notificationMessages).where(eq(notificationMessages.invoiceId, createdInvoiceId));
      await db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, createdInvoiceId));
      await db.delete(invoices).where(eq(invoices.id, createdInvoiceId));
    }
    await db.delete(meterReadings).where(inArray(meterReadings.meterId, [ids.meterA, ids.meterB]));
    await db.delete(meters).where(eq(meters.id, ids.meterB));
    await db.delete(meters).where(eq(meters.id, ids.meterA));
    await db.delete(subscribers).where(eq(subscribers.id, ids.subscriberB));
    await db.delete(subscribers).where(eq(subscribers.id, ids.subscriberA));
    if (createdSubscriberIds.length) await db.delete(subscribers).where(inArray(subscribers.id, createdSubscriberIds));
    await db.delete(staffProfiles).where(inArray(staffProfiles.userId, [ids.userManager, ids.userAccountant, ids.userCollector, ids.userTechnician, ids.userViewer]));
    await db.delete(tariffs).where(eq(tariffs.id, ids.tariffA));
    await db.delete(auditLogs).where(inArray(auditLogs.siteId, [ids.siteA, ids.siteA2, ids.siteB]));
    await db.delete(sites).where(inArray(sites.id, [ids.siteA, ids.siteA2, ids.siteB]));
    await db.delete(tenantMembers).where(inArray(tenantMembers.tenantId, [ids.tenantA, ids.tenantB]));
    await db.delete(tenants).where(inArray(tenants.id, [ids.tenantA, ids.tenantB]));
    await db.delete(users).where(inArray(users.id, [ids.userA, ids.userB, ids.userManager, ids.userAccountant, ids.userCollector, ids.userTechnician, ids.userViewer]));
  });
});
