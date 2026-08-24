import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { auditLogs, collectorSessions, invoiceLines, invoices, meterReadings, notificationMessages, payments, sitePortalSettings, sites, staffProfiles, subscribers, tariffs, tenantMembers, tenantMessagingConfigurations, tenantOwnerProfiles, tenants, users } from "../drizzle/schema";
import { getDb } from "./db";
import { powerhubRouter } from "./powerhub";

const runDatabaseIsolationTest = process.env.RUN_TENANT_ISOLATION_TESTS === "1";
const testIfEnabled = runDatabaseIsolationTest ? it : it.skip;
const suffix = `isolation-${Date.now()}`;
let ids: { userA: number; userB: number; userManager: number; userAccountant: number; userCollector: number; userTechnician: number; userViewer: number; userSiteOwner: number; tenantA: number; tenantB: number; siteA: number; siteA2: number; siteB: number; subscriberA: number; baseReadingA: number; tariffA: number; subscriberB: number; readingB: number };
const createdPaymentIds: number[] = [];
let createdReadingA: number | undefined;
const createdSubscriberIds: number[] = [];
const createdInvoiceIds: number[] = [];
let createdCollectorSessionId: number | undefined;

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
    const userSiteOwner = insertId(await db.insert(users).values({ openId: `${suffix}-site-owner`, name: "Site Owner A", role: "user" }));
    const tenantA = insertId(await db.insert(tenants).values({ name: "Tenant A", slug: `${suffix}-a` }));
    const tenantB = insertId(await db.insert(tenants).values({ name: "Tenant B", slug: `${suffix}-b` }));
    await db.insert(tenantMembers).values([{ tenantId: tenantA, userId: userA, role: "owner" }, { tenantId: tenantA, userId: userManager, role: "member" }, { tenantId: tenantA, userId: userAccountant, role: "member" }, { tenantId: tenantA, userId: userCollector, role: "member" }, { tenantId: tenantA, userId: userTechnician, role: "member" }, { tenantId: tenantA, userId: userViewer, role: "member" }, { tenantId: tenantB, userId: userB, role: "owner" }]);
    await db.insert(tenantOwnerProfiles).values([{ tenantId: tenantA, ownerUserId: userA, fullName: "Owner A", phone: `+97077${Date.now().toString().slice(-7)}`, companyName: "شركة A" }, { tenantId: tenantB, ownerUserId: userB, fullName: "Owner B", phone: `+97076${Date.now().toString().slice(-7)}`, companyName: "شركة B" }]);
    await db.insert(tenantMessagingConfigurations).values([
      { tenantId: tenantA, channel: "whatsapp", provider: "local-whatsapp", isActive: true },
      { tenantId: tenantA, channel: "sms", provider: "local-sms", isActive: true },
    ]);
    const siteA = insertId(await db.insert(sites).values({ tenantId: tenantA, name: "Site A", code: `${suffix}-a`.toUpperCase() }));
    const siteA2 = insertId(await db.insert(sites).values({ tenantId: tenantA, name: "Site A2", code: `${suffix}-a2`.toUpperCase() }));
    const siteB = insertId(await db.insert(sites).values({ tenantId: tenantB, name: "Site B", code: `${suffix}-b`.toUpperCase() }));
    await db.insert(sitePortalSettings).values([
      { tenantId: tenantA, siteId: siteA, portalCode: `${suffix}-a`, displayName: "بوابة A" },
      { tenantId: tenantB, siteId: siteB, portalCode: `${suffix}-b`, displayName: "بوابة B" },
    ]);
    await db.insert(staffProfiles).values([{ tenantId: tenantA, siteId: siteA, userId: userManager, role: "manager" }, { tenantId: tenantA, siteId: siteA, userId: userAccountant, role: "accountant" }, { tenantId: tenantA, siteId: siteA, userId: userCollector, role: "collector" }, { tenantId: tenantA, siteId: siteA, userId: userTechnician, role: "technician" }, { tenantId: tenantA, siteId: siteA, userId: userViewer, role: "viewer" }]);
    const subscriberA = insertId(await db.insert(subscribers).values({ tenantId: tenantA, siteId: siteA, subscriberNo: `${suffix}-a`, fullName: "Subscriber A", phone: "+970700000010" }));
    const baseReadingA = insertId(await db.insert(meterReadings).values({ tenantId: tenantA, subscriberId: subscriberA, readingValue: "10", status: "approved" }));
    const tariffA = insertId(await db.insert(tariffs).values({ tenantId: tenantA, siteId: siteA, name: "Tariff A", code: `${suffix}-tariff`, pricePerKwh: "1.5", fixedFee: "2", taxRate: "0" }));
    const subscriberB = insertId(await db.insert(subscribers).values({ tenantId: tenantB, siteId: siteB, subscriberNo: suffix, fullName: "Subscriber B", phone: "+970700000000" }));
    const readingB = insertId(await db.insert(meterReadings).values({ tenantId: tenantB, subscriberId: subscriberB, readingValue: "100", status: "approved" }));
    ids = { userA, userB, userManager, userAccountant, userCollector, userTechnician, userViewer, userSiteOwner, tenantA, tenantB, siteA, siteA2, siteB, subscriberA, baseReadingA, tariffA, subscriberB, readingB };
  });

  testIfEnabled("rejects cross-tenant identifiers and cross-site manager access", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [ownerA] = await db.select().from(users).where(eq(users.id, ids.userA));
    const caller = powerhubRouter.createCaller({ user: ownerA, req: {} as never, res: {} as never });
    await expect(caller.staff.myAccess({ siteId: ids.siteA })).resolves.toEqual({ role: "owner" });
    await expect(caller.sites.list()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: ids.siteA }), expect.objectContaining({ id: ids.siteA2 })]));
    await expect(caller.dashboard.allBranchesSummary({ siteId: ids.siteA })).resolves.toMatchObject({ branchCount: 2 });
    const ownerSubscriber = await caller.subscribers.create({ siteId: ids.siteA, fullName: "Owner Site", phone: "+970700000003", subscriptionType: "residential" });
    expect(ownerSubscriber.subscriberNo).toMatch(/^PH-/);
    const referenceMessages = await db.select().from(notificationMessages).where(eq(notificationMessages.subscriberId, ownerSubscriber.id));
    expect(referenceMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "subscriber_reference", channel: "whatsapp", recipient: "+970700000003" }),
      expect.objectContaining({ eventType: "subscriber_reference", channel: "sms", recipient: "+970700000003" }),
    ]));
    createdSubscriberIds.push(ownerSubscriber.id);
    await db.insert(tenantMembers).values({ tenantId: ids.tenantA, userId: ids.userSiteOwner, role: "member", isActive: true, membershipStatus: "active" });
    await db.insert(staffProfiles).values({ tenantId: ids.tenantA, siteId: ids.siteA, userId: ids.userSiteOwner, role: "owner", isActive: true });
    const [siteOwnerUser] = await db.select().from(users).where(eq(users.id, ids.userSiteOwner));
    const siteOwnerCaller = powerhubRouter.createCaller({ user: siteOwnerUser, req: {} as never, res: {} as never });
    await expect(siteOwnerCaller.staff.myAccess({ siteId: ids.siteA })).resolves.toEqual({ role: "owner" });
    await expect(siteOwnerCaller.subscribers.list({ siteId: ids.siteA2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(siteOwnerCaller.sites.list()).resolves.toEqual([expect.objectContaining({ id: ids.siteA })]);
    await expect(caller.payments.create({ siteId: ids.siteA, subscriberId: ids.subscriberB, paymentNo: `${suffix}-payment`, amount: 10, paymentMethod: "cash" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.invoices.createFromReading({ siteId: ids.siteA, readingId: ids.readingB, tariffId: 999999, billingPeriod: "2026-08", dueDate: new Date("2026-08-31"), discountAmount: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.messaging.listConfigurations({ siteId: ids.siteB })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.collectorSessions.list({ siteId: ids.siteB })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [manager] = await db.select().from(users).where(eq(users.id, ids.userManager));
    const managerCaller = powerhubRouter.createCaller({ user: manager, req: {} as never, res: {} as never });
    await expect(managerCaller.sites.list()).resolves.toEqual([expect.objectContaining({ id: ids.siteA })]);
    await expect(managerCaller.dashboard.allBranchesSummary({ siteId: ids.siteA })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(managerCaller.subscribers.list({ siteId: ids.siteA2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(managerCaller.subscribers.create({ siteId: ids.siteA2, fullName: "Cross Site", phone: "+970700000001", subscriptionType: "residential" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const managerSubscriber = await managerCaller.subscribers.create({ siteId: ids.siteA, fullName: "Manager Site", phone: "+970700000002", subscriptionType: "residential" });
    expect(managerSubscriber.subscriberNo).toMatch(/^PH-/);
    createdSubscriberIds.push(managerSubscriber.id);
  }, 15000);

  testIfEnabled("reveals public subscriber data only when portal code, reference number, and phone all match", async () => {
    const publicCaller = powerhubRouter.createCaller({ user: null, req: {} as never, res: {} as never } as never);
    await expect(publicCaller.subscriberPortal.lookup({ portalCode: `${suffix}-a`, subscriberNo: `${suffix}-a`, phone: "+970700000010" })).resolves.toMatchObject({
      portal: { portalCode: `${suffix}-a`, displayName: "بوابة A" },
      subscriber: { fullName: "Subscriber A", subscriberNo: `${suffix}-a` },
    });
    await expect(publicCaller.subscriberPortal.lookup({ portalCode: `${suffix}-a`, subscriberNo: `${suffix}-a`, phone: "+970700000000" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(publicCaller.subscriberPortal.lookup({ portalCode: `${suffix}-b`, subscriberNo: `${suffix}-a`, phone: "+970700000010" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  testIfEnabled("enforces accountant, collector, technician, and viewer boundaries", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const selectUser = async (id: number) => (await db.select().from(users).where(eq(users.id, id)))[0];
    const accountant = powerhubRouter.createCaller({ user: await selectUser(ids.userAccountant), req: {} as never, res: {} as never });
    const collector = powerhubRouter.createCaller({ user: await selectUser(ids.userCollector), req: {} as never, res: {} as never });
    const technician = powerhubRouter.createCaller({ user: await selectUser(ids.userTechnician), req: {} as never, res: {} as never });
    const viewer = powerhubRouter.createCaller({ user: await selectUser(ids.userViewer), req: {} as never, res: {} as never });
    const accountantSubscriber = await accountant.subscribers.create({ siteId: ids.siteA, fullName: "Accountant Site", phone: "+970700000004", subscriptionType: "commercial" });
    createdSubscriberIds.push(accountantSubscriber.id);
    const accountantPayment = await accountant.payments.create({ siteId: ids.siteA, subscriberId: ids.subscriberA, paymentNo: `${suffix}-accountant`, amount: 1, paymentMethod: "cash" });
    const collectorSession = await collector.collectorSessions.open({ siteId: ids.siteA, openingCash: 5 });
    createdCollectorSessionId = collectorSession.id;
    const collectorPayment = await collector.payments.create({ siteId: ids.siteA, subscriberId: ids.subscriberA, paymentNo: `${suffix}-collector`, amount: 1, paymentMethod: "cash" });
    createdPaymentIds.push(accountantPayment.id, collectorPayment.id);
    await expect(collector.collectorSessions.close({ siteId: ids.siteA, sessionId: collectorSession.id, declaredCash: 6 })).resolves.toMatchObject({ expectedCash: 6, varianceAmount: 0 });
    const reading = await technician.readings.create({ siteId: ids.siteA, subscriberId: ids.subscriberA, readingValue: "12", captureMethod: "manual" });
    createdReadingA = reading.id;
    await expect(technician.payments.create({ siteId: ids.siteA, subscriberId: ids.subscriberA, paymentNo: `${suffix}-technician`, amount: 1, paymentMethod: "cash" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(collector.readings.create({ siteId: ids.siteA, subscriberId: ids.subscriberA, readingValue: "13", captureMethod: "manual" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewer.readings.create({ siteId: ids.siteA, subscriberId: ids.subscriberA, readingValue: "13", captureMethod: "manual" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewer.payments.create({ siteId: ids.siteA, subscriberId: ids.subscriberA, paymentNo: `${suffix}-viewer`, amount: 1, paymentMethod: "cash" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  testIfEnabled("replays one offline operation without duplicating its subscriber reading", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [owner] = await db.select().from(users).where(eq(users.id, ids.userA));
    const ownerCaller = powerhubRouter.createCaller({ user: owner, req: {} as never, res: {} as never });
    const clientOperationId = crypto.randomUUID();
    const input = { siteId: ids.siteA, subscriberId: ids.subscriberA, readingValue: "15", captureMethod: "manual" as const, clientOperationId };
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
    createdInvoiceIds.push(invoice.id);
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id));
    const queuedNotifications = await db.select().from(notificationMessages).where(eq(notificationMessages.invoiceId, invoice.id));
    expect(lines).toHaveLength(3);
    expect(queuedNotifications).toHaveLength(2);
    expect(queuedNotifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenantId: ids.tenantA, channel: "whatsapp", eventType: "invoice_issued", status: "pending" }),
      expect.objectContaining({ tenantId: ids.tenantA, channel: "sms", eventType: "invoice_issued", status: "pending" }),
    ]));
    const notification = queuedNotifications.find((message) => message.channel === "whatsapp");
    if (!notification) throw new Error("Expected queued WhatsApp notification");
    const [ownerB] = await db.select().from(users).where(eq(users.id, ids.userB));
    const otherTenantCaller = powerhubRouter.createCaller({ user: ownerB, req: {} as never, res: {} as never });
    await expect(otherTenantCaller.notifications.retry({ siteId: ids.siteB, notificationId: notification.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.update(notificationMessages).set({ status: "failed", lastError: "اختبار مزود محلي" }).where(eq(notificationMessages.id, notification.id));
    await expect(ownerCaller.notifications.retry({ siteId: ids.siteA, notificationId: notification.id })).resolves.toEqual({ success: true });
    const [retried] = await db.select().from(notificationMessages).where(eq(notificationMessages.id, notification.id));
    expect(retried).toMatchObject({ status: "pending", lastError: null });
  });

  testIfEnabled("executes owner subscriber, reading, and partial invoice-payment workflows", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [owner] = await db.select().from(users).where(eq(users.id, ids.userA));
    const ownerCaller = powerhubRouter.createCaller({ user: owner, req: {} as never, res: {} as never });

    const createdSubscriber = await ownerCaller.subscribers.create({
      siteId: ids.siteA,
      fullName: "مشترك اختبار المالك",
      phone: "+970700000099",
      subscriptionType: "residential",
      address: "عنوان اختبار تشغيلي",
    });
    createdSubscriberIds.push(createdSubscriber.id);
    const [subscriber] = await db.select().from(subscribers).where(eq(subscribers.id, createdSubscriber.id));
    expect(subscriber).toMatchObject({ tenantId: ids.tenantA, siteId: ids.siteA, fullName: "مشترك اختبار المالك", serviceStatus: "active" });
    expect(createdSubscriber.subscriberNo).toBe(subscriber.subscriberNo);
    expect(createdSubscriber.subscriberNo).toMatch(/^PH-[A-Z0-9]+-[A-F0-9]{6}$/);

    const createdMeter = await ownerCaller.meters.create({
      siteId: ids.siteA,
      subscriberId: createdSubscriber.id,
      serialNumber: `${suffix}-owner-workflow-meter`,
      meterType: "manual",
      multiplier: "1",
    });
    createdMeterIds.push(createdMeter.id);
    const createdReading = await ownerCaller.readings.create({
      siteId: ids.siteA,
      meterId: createdMeter.id,
      readingValue: "60",
      captureMethod: "manual",
      notes: "قراءة اختبارية لمسار المالك",
    });
    expect(createdReading).toMatchObject({ consumptionKwh: 60, status: "pending_review", replayed: false });
    await expect(ownerCaller.readings.approve({ siteId: ids.siteA, readingId: createdReading.id, baseVersion: 1 })).resolves.toEqual({ success: true });

    const invoice = await ownerCaller.invoices.createFromReading({
      siteId: ids.siteA,
      readingId: createdReading.id,
      tariffId: ids.tariffA,
      billingPeriod: "2026-09",
      dueDate: new Date("2026-09-30"),
      discountAmount: 0,
    });
    createdInvoiceIds.push(invoice.id);
    expect(invoice.totalAmount).toBe(92);

    const partialPayment = await ownerCaller.payments.create({
      siteId: ids.siteA,
      subscriberId: createdSubscriber.id,
      invoiceId: invoice.id,
      paymentNo: `${suffix}-owner-partial`,
      amount: 40,
      paymentMethod: "cash",
      referenceNo: "اختبار-دفعة-جزئية",
    });
    createdPaymentIds.push(partialPayment.id);
    const [updatedInvoice] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    const [payment] = await db.select().from(payments).where(eq(payments.id, partialPayment.id));
    expect(updatedInvoice).toMatchObject({ paidAmount: "40.00", balanceDue: "52.00", status: "partially_paid" });
    expect(payment).toMatchObject({ invoiceId: invoice.id, subscriberId: createdSubscriber.id, amount: "40.00", status: "completed" });
  });

  testIfEnabled("exports a consolidated financial report only to an all-branches role", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [owner] = await db.select().from(users).where(eq(users.id, ids.userA));
    const [accountantUser] = await db.select().from(users).where(eq(users.id, ids.userAccountant));
    const ownerCaller = powerhubRouter.createCaller({ user: owner, req: {} as never, res: {} as never });
    const accountantCaller = powerhubRouter.createCaller({ user: accountantUser, req: {} as never, res: {} as never });
    const report = await ownerCaller.reports.allBranchesRange({ siteId: ids.siteA, startDate: "2026-01-01", endDate: "2026-12-31" });
    expect(report).toMatchObject({ scope: { branchCount: 2 } });
    expect(report.branchSummaries).toEqual(expect.arrayContaining([expect.objectContaining({ siteId: ids.siteA, branchName: "Site A" })]));
    expect(report.summary.invoiced).toBeGreaterThan(0);
    await expect(accountantCaller.reports.allBranchesRange({ siteId: ids.siteA, startDate: "2026-01-01", endDate: "2026-12-31" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  testIfEnabled("allows only the owner to update the official report company identity", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [owner] = await db.select().from(users).where(eq(users.id, ids.userA));
    const [manager] = await db.select().from(users).where(eq(users.id, ids.userManager));
    const ownerCaller = powerhubRouter.createCaller({ user: owner, req: {} as never, res: {} as never });
    const managerCaller = powerhubRouter.createCaller({ user: manager, req: {} as never, res: {} as never });
    await expect(managerCaller.reportBranding.update({ siteId: ids.siteA, companyName: "هوية غير مصرح بها" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ownerCaller.reportBranding.update({ siteId: ids.siteA, companyName: "شركة تقرير A" })).resolves.toMatchObject({ companyName: "شركة تقرير A", logoUrl: null });
    await expect(ownerCaller.reportBranding.get({ siteId: ids.siteA })).resolves.toMatchObject({ companyName: "شركة تقرير A", logoUrl: null });
  });

  afterAll(async () => {
    if (!runDatabaseIsolationTest || !ids) return;
    const db = await getDb();
    if (!db) return;
    if (createdPaymentIds.length) await db.delete(payments).where(inArray(payments.id, createdPaymentIds));
    if (createdCollectorSessionId) await db.delete(collectorSessions).where(eq(collectorSessions.id, createdCollectorSessionId));
    if (createdInvoiceIds.length) {
      await db.delete(notificationMessages).where(inArray(notificationMessages.invoiceId, createdInvoiceIds));
      await db.delete(invoiceLines).where(inArray(invoiceLines.invoiceId, createdInvoiceIds));
      await db.delete(invoices).where(inArray(invoices.id, createdInvoiceIds));
    }
    if (createdSubscriberIds.length) await db.delete(notificationMessages).where(inArray(notificationMessages.subscriberId, createdSubscriberIds));
    await db.delete(meterReadings).where(inArray(meterReadings.subscriberId, [ids.subscriberA, ids.subscriberB, ...createdSubscriberIds]));
    await db.delete(subscribers).where(eq(subscribers.id, ids.subscriberB));
    await db.delete(subscribers).where(eq(subscribers.id, ids.subscriberA));
    if (createdSubscriberIds.length) await db.delete(subscribers).where(inArray(subscribers.id, createdSubscriberIds));
    await db.delete(staffProfiles).where(inArray(staffProfiles.userId, [ids.userManager, ids.userAccountant, ids.userCollector, ids.userTechnician, ids.userViewer, ids.userSiteOwner]));
    await db.delete(tariffs).where(eq(tariffs.id, ids.tariffA));
    await db.delete(auditLogs).where(inArray(auditLogs.siteId, [ids.siteA, ids.siteA2, ids.siteB]));
    await db.delete(sitePortalSettings).where(inArray(sitePortalSettings.siteId, [ids.siteA, ids.siteA2, ids.siteB]));
    await db.delete(sites).where(inArray(sites.id, [ids.siteA, ids.siteA2, ids.siteB]));
    await db.delete(tenantOwnerProfiles).where(inArray(tenantOwnerProfiles.tenantId, [ids.tenantA, ids.tenantB]));
    await db.delete(tenantMessagingConfigurations).where(inArray(tenantMessagingConfigurations.tenantId, [ids.tenantA, ids.tenantB]));
    await db.delete(tenantMembers).where(inArray(tenantMembers.tenantId, [ids.tenantA, ids.tenantB]));
    await db.delete(tenants).where(inArray(tenants.id, [ids.tenantA, ids.tenantB]));
    await db.delete(users).where(inArray(users.id, [ids.userA, ids.userB, ids.userManager, ids.userAccountant, ids.userCollector, ids.userTechnician, ids.userViewer, ids.userSiteOwner]));
  });
});
