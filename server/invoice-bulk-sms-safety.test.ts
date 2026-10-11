import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const api = fs.readFileSync(path.join(root, "server/powerhub.ts"), "utf8");
const billingPage = fs.readFileSync(path.join(root, "client/src/pages/BillingPage.tsx"), "utf8");
const stateHelper = fs.readFileSync(path.join(root, "client/src/lib/billing-notification-state.ts"), "utf8");
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/20261011140000_powerhub_invoice_bulk_send_safety.sql"),
  "utf8",
);

describe("invoice bulk SMS safety contract", () => {
  it("queues missing invoice notifications in bounded database-safe batches", () => {
    expect(api).toContain("queueMissing?: boolean");
    expect(api).toContain("for (let offset = 0; offset < invoiceIds.length; offset += 50)");
    expect(api).toContain("slice(offset, offset + 50)");
    expect(api).toContain('.range(invoiceOffset, invoiceOffset + 199)');
    expect(api).toContain('includeFailed: false, dueOnly: true, queueMissing: true');
  });

  it("processes due pending SMS only and counts only due pending invoice messages", () => {
    expect(api).toContain('if (input.dueOnly) pendingQuery = pendingQuery.or("scheduled_at.is.null,scheduled_at.lte." + new Date().toISOString())');
    expect(api).toContain('countDueInvoiceNotifications: protectedProcedure.input(siteScoped)');
    expect(api).toContain('.eq("status", "pending")');
    expect(api).toContain('.or(`scheduled_at.is.null,scheduled_at.lte.${now}`)');
  });

  it("does not bypass retry/review/schedule states when a notification already exists", () => {
    expect(migration).toContain("v_existing.status in ('pending','processing','submitted','delivered','read','failed','needs_review')");
    expect(migration).toContain("if v_invoice.status in ('draft','cancelled') then");
    expect(migration).toContain("raise exception 'INVOICE_OUT_OF_SCOPE'");
    expect(migration).toContain("raise exception 'INVOICE_NOT_SENDABLE'");
  });

  it("uses unified templates first and keeps the legacy invoice template fallback and secure link flow", () => {
    expect(migration).toContain("from public.powerhub_message_templates");
    expect(migration).toContain("from public.tenant_invoice_message_templates");
    expect(migration).toContain("public.powerhub_create_invoice_share_link");
    expect(migration).toContain("'{{invoice_link}}'");
    expect(migration).toContain("'{{portal_link}}'");
  });

  it("limits direct function execution to the trusted service role", () => {
    expect(migration).toContain("revoke execute on function public.powerhub_queue_selected_invoice_sms(bigint,bigint,bigint,bigint[]) from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.powerhub_queue_selected_invoice_sms(bigint,bigint,bigint,bigint[]) to service_role");
  });

  it("keeps UI eligibility dependent on a successful page-scoped SMS lookup", () => {
    expect(billingPage).toContain('invoiceIds: invoicesQuery.data?.items.map((invoice) => invoice.id) ?? []');
    expect(billingPage).toContain('enabled: enabled && invoicesQuery.isSuccess');
    expect(billingPage).toContain('isInvoiceSmsEligibleForNewQueue(');
    expect(stateHelper).toContain('queryState === "ready" && statuses.length === 0');
    expect(billingPage).toContain('invoiceIds: input.invoiceIds, includeFailed: false, dueOnly: true');
  });
});
