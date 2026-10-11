import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/20261011110000_powerhub_reading_cycle_anchor_modes.sql"),
  "utf8",
);

describe("reading cycle anchor modes", () => {
  it("supports both 10-day patterns and clamps the alternate day 30 anchor to February's final day", () => {
    expect(migration).toContain("if c.monthly_start_day = 1 then");
    expect(migration).toContain("Alternate 10/20/30 anchor");
    expect(migration).toContain("least(30, last_day)");
    expect(migration).toContain("extract(month from local_at)::integer = 2 and extract(day from local_at)::integer >= 28");
    expect(migration).toContain("start_day := null;");
    expect(migration).toContain("start_day = 10");
    expect(migration).toContain("start_day = 20");
  });

  it("supports both 15-day patterns and keeps the next cycle boundary contiguous", () => {
    expect(migration).toContain("Alternate 15/30 anchor");
    expect(migration).toContain("start_day is null or start_day = case when extract(month from local_at)::integer = 2 then 28 else least(30, last_day) end");
    expect(migration).toContain("start_day = 16");
    expect(migration).toContain("start_day = 21");
  });

  it("uses PostgreSQL microsecond precision so inclusive cycle ends touch the next start", () => {
    expect(migration).toContain("interval '1 microsecond'");
    expect(migration).not.toContain("interval '1 millisecond'");
  });

  it("preserves timezone-aware cycle keys and restricts execution to service_role", () => {
    expect(migration).toContain("local_at := p_reading_at at time zone c.timezone");
    expect(migration).toContain("cycle_key := c.cycle_type || ':'");
    expect(migration).toContain("revoke execute on function public.powerhub_cycle_for_reading(bigint,bigint,timestamptz) from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.powerhub_cycle_for_reading(bigint,bigint,timestamptz) to service_role");
  });
});

describe("operations UI contracts", () => {
  const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

  it("exposes tariff management in settings and both anchor patterns for non-weekly cycles", () => {
    const settings = read("client/src/pages/SettingsPage.tsx");
    expect(settings).toContain("تعرفة الكيلوواط");
    expect(settings).toContain("10 / 20 / 30 (فبراير: 28)");
    expect(settings).toContain("15 / 30 (فبراير: 28)");
    expect(settings).toContain("1 / 11 / 21");
    expect(settings).toContain("1 / 16");
  });

  it("keeps the operations invoice tab as a concise overview without duplicate tariff management", () => {
    const operations = read("client/src/pages/OperationsPage.tsx");
    expect(operations).toContain("function InvoicesOverview");
    expect(operations).toContain("فتح مركز الفواتير والفلاتر");
    expect(operations).not.toContain("function InvoicesModule");
    expect(operations).not.toContain("SectionCard title=\"إضافة تعرفة\"");
  });

  it("provides predictive subscriber search and a collapsible standalone add-subscriber card", () => {
    const directory = read("client/src/pages/NetworkDirectoryPage.tsx");
    expect(directory).toContain("بحث ذكي وسريع");
    expect(directory).toContain("subscriber-autocomplete-");
    expect(directory).toContain("طي البطاقة");
    expect(directory).toContain("سجل {title}");
    expect(directory).toContain(">ملف المشترك</Button>");
    expect(directory).toContain('kind === "subscribers" ? "space-y-6"');
    const operations = read("client/src/pages/OperationsPage.tsx");
    expect(operations).toContain("function SubscribersOverview");
    expect(operations).not.toContain("function SubscribersModule");
  });

  it("lets authorized users view saved reading photos through a scoped signed-url route", () => {
    const page = read("client/src/pages/MeterReadingsPage.tsx");
    const server = read("server/powerhub.ts");
    expect(page).toContain("عرض الصورة");
    expect(page).toContain("readings.getImage");
    expect(page).toContain("صورة القراءة المرفقة");
    expect(server).toContain("getImage: protectedProcedure");
    expect(server).toContain("storageGet(reading.image_key)");
  });

  it("translates operational audit actions into Arabic", () => {
    const audit = read("client/src/pages/AuditLogPage.tsx");
    const operations = read("client/src/pages/OperationsPage.tsx");
    expect(audit).toContain("automatic_opening_baseline_approval: \"اعتماد القراءة الافتتاحية تلقائياً\"");
    expect(operations).toContain("auditActionLabels[x.action]");
    expect(operations).toContain("auditEntityLabels[x.entityType]");
  });

  it("uses a plain invoices title and supports the requested date filters", () => {
    const billing = read("client/src/pages/BillingPage.tsx");
    expect(billing).toContain("فلتر فترة الفواتير");
    expect(billing).toContain("الدورة الحالية");
    expect(billing).toContain("آخر 7 أيام");
    expect(billing).toContain("آخر شهر");
    expect(billing).toContain("بداية فترة الفواتير");
    expect(billing).not.toContain("الفواتير والتعرفات");
    expect(billing).not.toContain('Panel title="إصدار فاتورة"');
  });
});
