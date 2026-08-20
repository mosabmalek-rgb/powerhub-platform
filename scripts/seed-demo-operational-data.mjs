import { eq } from "drizzle-orm";
import { getDb } from "../server/db.ts";
import { sites, users } from "../drizzle/schema.ts";
import { powerhubRouter } from "../server/powerhub.ts";

const SITE_CODE = "DEMO-100K-01";
const SITE_NAME = "محطة النور التجريبية — 2×100 kW";
const TARIFF_CODE = "DEMO-KWH-33";
const TARGET_SUBSCRIBERS = 150;

function callerFor(user) {
  return powerhubRouter.createCaller({
    user,
    req: {} ,
    res: {},
  });
}

async function main() {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لإدخال بيانات المحطة التجريبية.");

  const ownerOpenId = process.env.OWNER_OPEN_ID;
  const ownerByOpenId = ownerOpenId
    ? await db.select().from(users).where(eq(users.openId, ownerOpenId)).limit(1)
    : [];
  const ownerByAdminRole = await db.select().from(users).where(eq(users.role, "admin")).limit(1);
  const owner = ownerByOpenId[0] ?? ownerByAdminRole[0];
  if (!owner) throw new Error("تعذر تحديد حساب المالك الحالي لإدخال البيانات التجريبية.");

  const caller = callerFor(owner);
  let [site] = await db.select().from(sites).where(eq(sites.code, SITE_CODE)).limit(1);
  if (!site) {
    const created = await caller.sites.create({ name: SITE_NAME, code: SITE_CODE, city: "بغداد", address: "بيانات تشغيلية تجريبية محلية" });
    [site] = await db.select().from(sites).where(eq(sites.id, created.id)).limit(1);
  }
  if (!site) throw new Error("تعذر إنشاء محطة البيانات التجريبية.");

  const visibleSites = await caller.sites.list();
  if (!visibleSites.some((visibleSite) => visibleSite.id === site.id)) {
    throw new Error("المحطة التجريبية لا تقع ضمن نطاق المالك الحالي؛ تم إيقاف الإدخال حمايةً لعزل المستأجر.");
  }

  const generatorSpecs = [
    { code: "DEMO-GEN-01", name: "مولد تجريبي 1 — 100 kW" },
    { code: "DEMO-GEN-02", name: "مولد تجريبي 2 — 100 kW" },
  ];
  const existingGenerators = await caller.generators.list({ siteId: site.id });
  for (const generator of generatorSpecs) {
    if (!existingGenerators.some((row) => row.code === generator.code)) {
      await caller.generators.create({
        siteId: site.id,
        code: generator.code,
        name: generator.name,
        serialNumber: `${generator.code}-SERIAL`,
        ratedCapacityKw: "100",
        fuelType: "diesel",
      });
    }
  }

  const existingTariffs = await caller.tariffs.list({ siteId: site.id });
  if (!existingTariffs.some((tariff) => tariff.code === TARIFF_CODE)) {
    await caller.tariffs.create({
      siteId: site.id,
      name: "التعرفة التجريبية — 33 لكل كيلوواط/ساعة",
      code: TARIFF_CODE,
      pricePerKwh: 33,
      fixedFee: 0,
      taxRate: 0,
    });
  }

  const existingSubscribers = await caller.subscribers.list({ siteId: site.id });
  const existingSubscriberNumbers = new Set(existingSubscribers.map((subscriber) => subscriber.subscriberNo));
  for (let number = 1; number <= TARGET_SUBSCRIBERS; number += 1) {
    const subscriberNo = `DEMO-SUB-${String(number).padStart(3, "0")}`;
    if (!existingSubscriberNumbers.has(subscriberNo)) {
      await caller.subscribers.create({
        siteId: site.id,
        subscriberNo,
        fullName: `مشترك تجريبي ${String(number).padStart(3, "0")}`,
        phone: `079000${String(number).padStart(4, "0")}`,
        address: `القطاع التجريبي ${Math.ceil(number / 25)}`,
        subscriptionType: number % 5 === 0 ? "commercial" : "residential",
      });
    }
  }

  const refreshedSubscribers = await caller.subscribers.list({ siteId: site.id });
  const refreshedGenerators = await caller.generators.list({ siteId: site.id });
  const demoGenerators = refreshedGenerators.filter((generator) => generator.code.startsWith("DEMO-GEN-"));
  const existingMeters = await caller.meters.list({ siteId: site.id });
  const meterSerials = new Set(existingMeters.map((row) => row.meter.serialNumber));
  for (const [index, subscriber] of refreshedSubscribers.filter((row) => row.subscriberNo.startsWith("DEMO-SUB-")).entries()) {
    const serialNumber = `DEMO-MTR-${String(index + 1).padStart(3, "0")}`;
    if (!meterSerials.has(serialNumber)) {
      await caller.meters.create({
        siteId: site.id,
        subscriberId: subscriber.id,
        generatorId: demoGenerators[index % demoGenerators.length]?.id,
        serialNumber,
        meterType: "manual",
        multiplier: "1",
      });
    }
  }

  const finalSubscribers = (await caller.subscribers.list({ siteId: site.id })).filter((subscriber) => subscriber.subscriberNo.startsWith("DEMO-SUB-"));
  const finalGenerators = (await caller.generators.list({ siteId: site.id })).filter((generator) => generator.code.startsWith("DEMO-GEN-"));
  const finalTariffs = (await caller.tariffs.list({ siteId: site.id })).filter((tariff) => tariff.code === TARIFF_CODE);
  const finalMeters = (await caller.meters.list({ siteId: site.id })).filter((row) => row.meter.serialNumber.startsWith("DEMO-MTR-"));

  console.log(JSON.stringify({
    siteId: site.id,
    tenantId: site.tenantId,
    siteCode: site.code,
    siteName: site.name,
    subscribers: finalSubscribers.length,
    generators: finalGenerators.length,
    generatorCapacityKw: finalGenerators.map((generator) => Number(generator.ratedCapacityKw)),
    tariffs: finalTariffs.length,
    pricePerKwh: Number(finalTariffs[0]?.pricePerKwh ?? 0),
    meters: finalMeters.length,
    targetSubscribers: TARGET_SUBSCRIBERS,
  }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
