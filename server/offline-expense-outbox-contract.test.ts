import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, "..", "supabase", "migrations", "20261029192000_powerhub_offline_expense_idempotency.sql"), "utf8");
const router = readFileSync(join(here, "powerhub.ts"), "utf8");
const queue = readFileSync(join(here, "..", "client", "src", "lib", "offline-work-queue.ts"), "utf8");
const replayPanel = readFileSync(join(here, "..", "client", "src", "components", "OfflineWorkSyncPanel.tsx"), "utf8");

describe("offline expense Outbox server boundary", () => {
  it("reuses the existing atomic expense/account RPC and stores its result in the same transaction", () => {
    expect(migration).toContain("public.powerhub_create_expense_with_account(");
    expect(migration).toContain("public.powerhub_expense_offline_operation_results");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(migration).toContain("return query select v_existing.expense_id,v_existing.transaction_id,true");
    expect(migration).toContain("return query select v_created.expense_id,v_created.transaction_id,false");
    expect(migration).toContain("revoke all on function public.powerhub_create_expense_with_account_idempotent");
    expect(migration).toContain("to service_role");
  });

  it("requires the normal server-side expense permission check before idempotent replay", () => {
    const start = router.indexOf("expenses: router({");
    const end = router.indexOf("dashboard: router({", start);
    const expenseRouter = router.slice(start, end);
    expect(expenseRouter).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageExpenses")');
    expect(expenseRouter).toContain("powerhub_create_expense_with_account_idempotent");
    expect(expenseRouter).toContain("p_client_operation_id: input.clientOperationId");
  });

  it("routes offline expenses through the shared Outbox with a stable operation ID", () => {
    expect(queue).toContain('"expense_create"');
    expect(replayPanel).toContain('item.kind === "expense_create"');
    expect(replayPanel).toContain("clientOperationId: item.clientOperationId");
  });
});
