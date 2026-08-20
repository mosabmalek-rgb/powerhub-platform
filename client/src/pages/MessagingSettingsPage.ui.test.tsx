// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MessagingSettingsPage from "./MessagingSettingsPage";

const state = vi.hoisted(() => ({ mutate: vi.fn(), policy: { configured: true, isEnabled: true, whatsappEnabled: true, smsEnabled: true, message: "القنوات مفتوحة للتجربة" } }));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, loading: false }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ powerhub: { messaging: { listConfigurations: { invalidate: vi.fn() }, deliveryPolicy: { invalidate: vi.fn() }, listInvoiceTemplates: { invalidate: vi.fn() } }, notifications: { list: { invalidate: vi.fn() } }, audit: { list: { invalidate: vi.fn() } } } }),
    powerhub: {
      sites: { list: { useQuery: () => ({ data: [{ id: 3, name: "محطة الاختبار" }] }) } },
      staff: { myAccess: { useQuery: () => ({ data: { role: "owner" } }) } },
      messaging: {
        listConfigurations: { useQuery: () => ({ data: [{ channel: "whatsapp", provider: "meta_whatsapp_cloud", phoneNumberId: "123", templateName: "invoice_ready_ar", isActive: true }] }) },
        deliveryPolicy: { useQuery: () => ({ data: state.policy }) },
        listInvoiceTemplates: { useQuery: () => ({ data: [{ channel: "whatsapp", body: "أهلاً {{subscriber_name}}، فاتورتك {{invoice_no}}", isActive: true }] }) },
        saveConfiguration: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        saveInvoiceTemplate: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
      },
      notifications: {
        list: { useQuery: () => ({ data: [{ invoiceNo: "INV-01", subscriber: { fullName: "مشترك الاختبار" }, notification: { id: 8, channel: "whatsapp", recipient: "0790000000", status: "failed", attempts: 2, lastError: "رفض المزود", createdAt: new Date("2026-08-20") } }] }) },
        retry: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
      },
    },
  },
}));

afterEach(() => { document.body.innerHTML = ""; state.mutate.mockReset(); state.policy = { configured: true, isEnabled: true, whatsappEnabled: true, smsEnabled: true, message: "القنوات مفتوحة للتجربة" }; });

describe("owner invoice messaging settings", () => {
  it("shows admin-gated channels, editable templates, and the invoice delivery log", () => {
    render(<MessagingSettingsPage />);
    expect(screen.getByText("ربط WhatsApp وSMS وقوالب الفاتورة")).toBeInTheDocument();
    expect(screen.getByText("القنوات مفتوحة للتجربة")).toBeInTheDocument();
    expect(screen.getByText("قالب فاتورة WhatsApp")).toBeInTheDocument();
    expect(screen.getByText("قالب فاتورة SMS")).toBeInTheDocument();
    expect(screen.getByText("سجل إرسال فواتير المشتركين")).toBeInTheDocument();
    expect(screen.getByText("إجمالي الرسائل المرسلة")).toBeInTheDocument();
    expect(screen.getByText("رفض المزود")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "معاينة الرسالة" })[0]);
    expect(screen.getByText("شكل الرسالة النهائي")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة إرسال" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "حفظ قالب WhatsApp" }));
    expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({ siteId: 3, channel: "whatsapp", isActive: true }));
  });

  it("blocks provider setup until the platform administrator explicitly opens the policy", () => {
    state.policy = { configured: false, isEnabled: true, whatsappEnabled: true, smsEnabled: true, message: "" };
    render(<MessagingSettingsPage />);
    expect(screen.getAllByText(/قناة .* غير متاحة/).length).toBe(2);
    expect(screen.queryByText("قالب فاتورة WhatsApp")).not.toBeInTheDocument();
  });
});
