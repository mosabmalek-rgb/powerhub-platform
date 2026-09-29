import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  approve: vi.fn(),
  notify: vi.fn(),
  access: vi.fn(),
  site: vi.fn(),
  audit: vi.fn(),
}));

const tableRows: Record<string, unknown> = {
  audit_logs: { user_id: 7, created_at: "2026-08-15T10:00:00.000Z" },
  meter_readings: { id: 60, subscriber_id: 30, reading_at: "2026-08-15T10:00:00.000Z", status: "pending_review" },
  subscribers: { id: 30 },
};

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: tableRows[table] ?? null, error: null }),
      };
      return chain;
    },
  }),
}));

vi.mock("./powerhub-mobile-approval-supabase", () => ({
  approveAndIssueMobileReadingSupabase: state.approve,
}));

vi.mock("./powerhub-supabase", () => ({
  requireSupabaseSiteRole: state.access,
  getSupabaseSite: state.site,
  writeSupabaseAudit: state.audit,
}));

vi.mock("./notification-worker", () => ({
  processNotificationById: state.notify,
}));

import { router } from "./_core/trpc";
import { approveAndIssueMobileReadingRuntime } from "./powerhub-mobile-approve-runtime";

const testRouter = router({ approveAndIssue: approveAndIssueMobileReadingRuntime });

describe("mobile approval Supabase runtime", () => {
  beforeEach(() => {
    state.approve.mockReset().mockResolvedValue({
      invoiceId: 71,
      invoiceNo: "PH-MAIN-202608-00002",
      totalAmount: 150,
      notificationIds: [91],
      alreadyProcessed: false,
    });
    state.notify.mockReset().mockResolvedValue({ status: "submitted", providerMessageId: "msg-91" });
    state.access.mockReset().mockResolvedValue({ tenantId: 20, role: "owner", permissions: [] });
    state.site.mockReset().mockResolvedValue({ id: 10, tenantId: 20, invoiceDueDays: 14 });
    state.audit.mockReset().mockResolvedValue(undefined);
  });

  it("uses the atomic Supabase approval adapter and does not need the legacy db module", async () => {
    const caller = testRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.approveAndIssue({ siteId: 10, readingId: 60, baseVersion: 1, sendNow: false }))
      .resolves.toMatchObject({ id: 71, invoiceNo: "PH-MAIN-202608-00002", totalAmount: 150, notificationMode: "deferred" });

    expect(state.approve).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 20,
      siteId: 10,
      userId: 1,
      readingId: 60,
      baseVersion: 1,
      billingPeriod: "2026-08",
      dueDate: new Date("2026-08-29T10:00:00.000Z"),
    }));
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("passes the authenticated actor into notification dispatch for sendNow", async () => {
    const caller = testRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.approveAndIssue({ siteId: 10, readingId: 60, baseVersion: 1, sendNow: true }))
      .resolves.toMatchObject({ notificationMode: "immediate", deliveries: [{ notificationId: 91, status: "submitted" }] });
    expect(state.notify).toHaveBeenCalledWith(91, 1);
  });
});
