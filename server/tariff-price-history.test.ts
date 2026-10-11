import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
const migration = read("supabase/migrations/20261011130000_powerhub_tariff_price_history.sql");
const settings = read("client/src/pages/SettingsPage.tsx");
const server = read("server/powerhub.ts");
const helper = read("server/powerhub-supabase.ts");
const tariffSection = settings.slice(settings.indexOf("function TariffSettingsSection"), settings.indexOf("function SubaccountListSkeleton"));

describe("kilowatt price history", () => {
  it("does not ask owners for a tariff name or tariff code", () => {
    expect(tariffSection).not.toContain('name="name"');
    expect(tariffSection).not.toContain('name="code"');
    expect(tariffSection).not.toContain("اسم التعرفة");
    expect(tariffSection).not.toContain("رمز التعرفة");
    expect(tariffSection).toContain("سعر الكيلوواط");
  });

  it("stores each price version in half-open, non-overlapping periods and backfills recoverable audit history", () => {
    expect(migration).toContain("create table if not exists public.tariff_price_history");
    expect(migration).toContain("valid_to is null or valid_to > valid_from");
    expect(migration).toContain("tariff_price_history_one_open_version");
    expect(migration).toContain("old.effective_from + interval '1 microsecond'");
    expect(migration).toContain("before_data->>'pricePerKwh'");
    expect(migration).toContain("'legacy_snapshot'");
    expect(migration).toContain("after insert or update on public.tariffs");
  });

  it("writes history in the same transaction as a rate change and protects the RPC with tenant/site permissions", () => {
    expect(migration).toContain("function public.powerhub_update_tariff_price");
    expect(migration).toContain("TARIFF_MANAGEMENT_FORBIDDEN");
    expect(migration).toContain("TARIFF_OUT_OF_SCOPE");
    expect(migration).toContain("insert into public.audit_logs");
    expect(migration).toContain("grant execute on function public.powerhub_update_tariff_price(bigint,bigint,bigint,bigint,numeric,numeric,numeric) to service_role");
  });

  it("uses a bounded, site-scoped date-overlap query for historical prices", () => {
    expect(server).toContain("history: protectedProcedure");
    expect(server).toContain("listSupabaseTariffPriceHistory(input.siteId, input)");
    expect(helper).toContain('.from("tariff_price_history")');
    expect(helper).toContain(".range(offset, offset + limit - 1)");
    expect(helper).toContain('timeZone: "Asia/Gaza"');
    expect(helper).toContain('query.or("valid_to.is.null,valid_to.gt."');
    expect(helper).toContain('query.lt("valid_from"');
  });

  it("creates a rate with internal-only identifiers and updates rates without passing a user-facing name or code", () => {
    expect(server).toContain('p_name: "سعر الكيلوواط", p_code: internalCode');
    expect(server).toContain('rpc("powerhub_update_tariff_price"');
    expect(server).not.toContain('name: z.string().min(2).max(160), code: z.string().min(2).max(50)');
  });

  it("shows date filters, rate history pagination, and avoids creating a period when the value did not change", () => {
    expect(tariffSection).toContain("سجل أسعار الكيلوواط وفترات السريان");
    expect(tariffSection).toContain("بداية فترة سجل سعر الكيلوواط");
    expect(tariffSection).toContain("نهاية فترة سجل سعر الكيلوواط");
    expect(tariffSection).toContain("historyQuery.data?.hasNext");
    expect(tariffSection).toContain("لم يتغير سعر الكيلوواط");
  });
});
