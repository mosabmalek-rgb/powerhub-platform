import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ rpc: state.rpc }),
}));

import { approveAndIssueMobileReadingSupabase } from "./powerhub-mobile-approval-supabase";

describe("approveAndIssueMobileReadingSupabase", () => {
  beforeEach(() => state.rpc.mockReset());

  it("calls the atomic Supabase RPC and maps the result", async () => {
    state.rpc.mockResolvedValue({
      data: [{ invoice_id: 71, invoice_no: "PH-MAIN-202608-00002", total_amount: "150.00", notification_ids: [91, 92], already_processed: false }],
      error: null,
    });

    await expect(approveAndIssueMobileReadingSupabase({
      tenantId: 20,
      siteId: 10,
      userId: 1,
      readingId: 60,
      baseVersion: 1,
      dueDate: new Date("2026-08-16T00:00:00.000Z"),
      billingPeriod: "2026-08",
      discountAmount: 0,
    })).resolves.toEqual({
      invoiceId: 71,
      invoiceNo: "PH-MAIN-202608-00002",
      totalAmount: 150,
      notificationIds: [91, 92],
      alreadyProcessed: false,
    });

    expect(state.rpc).toHaveBeenCalledWith("powerhub_approve_and_issue_mobile_reading", expect.objectContaining({
      p_tenant_id: 20,
      p_site_id: 10,
      p_user_id: 1,
      p_reading_id: 60,
      p_base_version: 1,
      p_billing_period: "2026-08",
      p_discount_amount: 0,
    }));
  });

  it("maps optimistic-concurrency conflicts to CONFLICT", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "READING_VERSION_CONFLICT" } });
    await expect(approveAndIssueMobileReadingSupabase({
      tenantId: 20,
      siteId: 10,
      userId: 1,
      readingId: 60,
      baseVersion: 1,
      dueDate: new Date("2026-08-16T00:00:00.000Z"),
      billingPeriod: "2026-08",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
