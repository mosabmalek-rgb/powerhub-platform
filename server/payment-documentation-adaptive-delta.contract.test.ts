import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const page = read("client/src/pages/PaymentDocumentationReviewPage.tsx");
const router = read("server/powerhub.ts");
const migration = read("supabase/migrations/20261101084256_powerhub_payment_documentation_revision_invalidation.sql");

describe("Payment Documentation Adaptive Delta revision", () => {
  it("exposes only an authorized opaque cursor and a server-derived site topic", () => {
    const root = router.indexOf("paymentDocumentation: router({");
    const start = router.indexOf("revision: protectedProcedure.input(siteScoped)", root);
    const end = router.indexOf("availableAccounts: protectedProcedure", start);
    const procedure = router.slice(start, end);
    expect(root).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(root);
    expect(end).toBeGreaterThan(start);
    expect(procedure).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [], "approvePaymentDocumentation")');
    expect(procedure).toContain("requirePaymentDocumentationFeature(access.tenantId)");
    expect(procedure).toContain('.eq("entity_type", "payment_documentation")');
    expect(procedure).toContain('.select("last_cursor")');
    expect(procedure).toContain("realtimeTopic: `powerhub:tenant:${access.tenantId}:site:${input.siteId}`");
    expect(procedure).not.toMatch(/payment_amount|receipt_image_key|subscriber_name_snapshot|row_data/);
  });

  it("uses the shared Adaptive Delta manager and has no page-local 15-second poller", () => {
    expect(page).toContain("useAdaptiveDeltaRefresh({");
    expect(page).toContain('scopeKey: "payment-documentation:"');
    expect(page).toContain("approvalRevisionQuery");
    expect(page).toContain("lastPaymentDocumentationRevisions");
    expect(page).toContain("void requests.refetch()");
    expect(page).toContain("refetchInterval:false");
    expect(page).not.toContain("refetchInterval:shouldPollRequests?15_000:false");
  });

  it("bumps only the opaque scope cursor and does not create raw payment Delta rows", () => {
    expect(migration).toContain("'payment_documentation'");
    expect(migration).toContain("powerhub_payment_documentation_revision");
    expect(migration).toContain("powerhub_sync_scope_state_broadcast_delta");
    expect(migration.toLowerCase()).not.toContain("insert into public.powerhub_sync_changes");
    expect(migration).not.toMatch(/row_data|receipt_image_key|payment_amount/);
  });
});
