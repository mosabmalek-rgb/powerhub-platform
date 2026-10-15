import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
const migration = read("supabase/migrations/20261015130000_powerhub_subscriber_statement_summary.sql");
const helper = read("server/powerhub-supabase.ts");
const statement = helper.slice(
  helper.indexOf("export async function getSupabaseSubscriberAccountStatement"),
  helper.indexOf("export async function listSupabaseTariffs"),
);

describe("scalable subscriber statement summary", () => {
  it("aggregates totals and counts in PostgreSQL with explicit tenant, site, and subscriber scope", () => {
    expect(migration).toContain("function public.powerhub_subscriber_statement_summary");
    expect(migration).toContain("i.tenant_id = p_tenant_id");
    expect(migration).toContain("i.site_id = p_site_id");
    expect(migration).toContain("i.subscriber_id = p_subscriber_id");
    expect(migration).toContain("p.status = 'completed'");
    expect(migration).toContain("i.status <> 'cancelled'");
    expect(migration).toContain("count(*)::bigint");
    expect(migration).toContain("coalesce(sum(i.balance_due), 0)");
    expect(migration).toContain("max(p.paid_at)");
  });

  it("exposes the summary RPC only to the server role", () => {
    expect(migration).toContain("security invoker");
    expect(migration).toContain("revoke all on function public.powerhub_subscriber_statement_summary(bigint, bigint, bigint) from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.powerhub_subscriber_statement_summary(bigint, bigint, bigint) to service_role");
  });

  it("does not transfer full historical tables just to calculate totals", () => {
    expect(statement).toContain('rpc("powerhub_subscriber_statement_summary"');
    expect(statement).not.toContain('.select("total_amount, paid_amount, balance_due, consumption_kwh")');
    expect(statement).not.toContain('.select("amount")');
    expect(statement).not.toContain('.select("id")\n      .eq("tenant_id", Number(subscriber.tenant_id)).eq("subscriber_id", subscriberId)');
    expect(statement).toContain(".limit(21)");
  });

  it("keeps displayed invoice, payment, and reading details bounded to the latest twenty rows", () => {
    expect((statement.match(/\.limit\(21\)/g) ?? []).length).toBe(3);
    expect(statement).toContain("invoiceHasMore: recentInvoices.length > 20");
    expect(statement).toContain("paymentHasMore: recentPayments.length > 20");
    expect(statement).toContain("readingHasMore: recentReadings.length > 20");
  });
});
