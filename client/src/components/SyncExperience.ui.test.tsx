// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineWorkSyncPanel } from "./OfflineWorkSyncPanel";
import PlatformSyncEventsPanel from "./PlatformSyncEventsPanel";

const state = vi.hoisted(() => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() }, syncQuery: { refetch: vi.fn() } }));

vi.mock("sonner", () => ({ toast: state.toast }));
vi.mock("@/lib/offline-work-queue", () => ({
  listOfflineWork: vi.fn().mockResolvedValue([{ id: "draft-1", userId: 7, siteId: 3, kind: "subscriber_create", status: "pending", createdAt: new Date("2026-09-11T10:00:00Z"), clientOperationId: "op-1", payload: { fullName: "مشترك اختبار" } }]),
  updateOfflineWork: vi.fn().mockResolvedValue(undefined),
  removeOfflineWork: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ powerhub: { subscribers: { list: { invalidate: vi.fn() }, quota: { invalidate: vi.fn() } }, invoices: { list: { invalidate: vi.fn() } }, payments: { list: { invalidate: vi.fn() } }, dashboard: { summary: { invalidate: vi.fn() } }, audit: { list: { invalidate: vi.fn() } } } }),
    powerhub: {
      subscribers: { create: { useMutation: () => ({ mutateAsync: vi.fn().mockResolvedValue({ id: 4, subscriberNo: "SUB-4" }) }) }, update: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
      invoices: { createFromReading: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
      payments: { create: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    },
    admin: { listSyncEvents: { useQuery: () => ({ data: [{ id: 1, tenantName: "مساحة الشمال", siteName: "فرع غزة", userId: 7, userName: "الفني أحمد", userEmail: null, deviceLabel: "هاتف ميداني", appVersion: "1.0.0", eventType: "sync_error", status: "needs_review", syncedCount: 2, retryableCount: 1, needsReviewCount: 1, errorCode: "CONFLICT", errorMessage: "تعارض قراءة", occurredAt: new Date("2026-09-11T10:00:00Z") }], isLoading: false, isFetching: false, refetch: state.syncQuery.refetch }) } },
  },
}));

afterEach(() => { state.toast.success.mockReset(); state.toast.warning.mockReset(); state.toast.error.mockReset(); state.syncQuery.refetch.mockReset(); });

describe("sync experience", () => {
  it("shows connection state and the manual sync button", async () => {
    render(<OfflineWorkSyncPanel siteId={3} userId={7} />);
    expect(await screen.findByRole("button", { name: /مزامنة الآن/ })).toBeInTheDocument();
    expect(screen.getByText(/الاتصال متاح/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /مزامنة الآن/ }));
    await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith("اكتملت محاولة مزامنة المسودات المعلقة."));
    fireEvent(window, new Event("offline"));
    expect(await screen.findByText(/لا يوجد اتصال/)).toBeInTheDocument();
    expect(state.toast.warning).toHaveBeenCalled();
  });

  it("renders the central admin sync log and conflict details", () => {
    render(<PlatformSyncEventsPanel />);
    expect(screen.getByText("سجل المزامنة والتعارضات")).toBeInTheDocument();
    expect(screen.getByText("مساحة الشمال")).toBeInTheDocument();
    expect(screen.getAllByText("تحتاج مراجعة").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/CONFLICT: تعارض قراءة/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "تحديث السجل" }));
    expect(state.syncQuery.refetch).toHaveBeenCalled();
  });
});
