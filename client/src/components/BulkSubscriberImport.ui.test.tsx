// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkSubscriberImport } from "./BulkSubscriberImport";

const state = vi.hoisted(() => ({ mutate: vi.fn(), onSaved: vi.fn().mockResolvedValue(undefined), options: null as null | { onSuccess: (value: { created: Array<{ sourceRow: number; fullName: string; subscriberNo: string }>; updated: Array<{ sourceRow: number; fullName: string; subscriberNo: string }>; failed: Array<{ sourceRow: number; fullName: string; reason: string }>; message: string }) => Promise<void> } }));
const workbook = vi.hoisted(() => ({
  worksheets: [{ eachRow: (callback: (row: { values: unknown[] }, index: number) => void) => {
    callback({ values: [undefined, "الاسم الكامل", "رقم الجوال الدولي", "العنوان", "نوع الاشتراك", "الرقم المرجعي"] }, 1);
    callback({ values: [undefined, "أحمد العلي", "+970599000001", "غزة", "سكني", "SUB-NORTH-001", 12.52, "2026-10-10"] }, 2);
    callback({ values: [undefined, "", "", "", "", "", 99.25] }, 3);
  } }],
  xlsx: { load: vi.fn().mockResolvedValue(undefined), writeBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)) },
}));

vi.mock("exceljs", () => ({ default: { Workbook: vi.fn(() => workbook) } }));
vi.mock("@/lib/trpc", () => ({ trpc: { powerhub: { subscribers: { bulkImport: { useMutation: (options: typeof state.options) => { state.options = options; return { mutate: state.mutate, isPending: false }; } } } } } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("استيراد المشتركين من Excel", () => {
  afterEach(() => { cleanup(); state.mutate.mockReset(); state.onSaved.mockClear(); state.options = null; });

  it("يعرض مدخل الملف والقالب مع توضيح أن الرقم المرجعي للتحديث فقط", () => {
    render(<BulkSubscriberImport siteId={7} onSaved={state.onSaved} />);
    expect(screen.getByText("إضافة مشتركين جماعياً")).toBeInTheDocument();
    expect(screen.getByText(/الرقم المرجعي في الملف يُستخدم فقط عند تفعيل تحديث/)).toBeInTheDocument();
    expect(screen.getByText("تنزيل القالب")).toBeInTheDocument();
    expect(screen.getByLabelText("رفع ملف Excel", { selector: "input" })).toHaveAttribute("accept", expect.stringContaining(".xlsx"));
  });

  it("لا يرسل الرقم المرجعي عند إنشاء مشترك جديد، ويترك رقم المشترك للخادم", async () => {
    render(<BulkSubscriberImport siteId={7} onSaved={state.onSaved} />);
    fireEvent.change(screen.getByLabelText("رفع ملف Excel", { selector: "input" }), { target: { files: [new File(["xlsx"], "subscribers.xlsx")] } });
    await screen.findByText("أحمد العلي");
    expect(screen.getByText("12.52")).toBeInTheDocument();
    expect(screen.getByText("99.25")).toBeInTheDocument();
    expect(screen.getByText(/أدخل الاسم الكامل/)).toBeInTheDocument();
    expect(screen.getByText(/سيُحفظ الملف كاملاً داخل معاملة ذرية/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /حفظ 1 مشتركاً سليماً/ }));
    expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 7,
      updateExisting: false,
      clientOperationId: expect.any(String),
      approveOpeningReadings: false,
      rows: [{ sourceRow: 2, subscriberNo: undefined, fullName: "أحمد العلي", phone: "+970599000001", whatsappNumber: undefined, address: "غزة", subscriptionType: "residential", openingReading: "12.52", openingReadingAt: expect.any(String) }],
    }));
  });
});