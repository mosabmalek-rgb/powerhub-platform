// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkSubscriberImport } from "./BulkSubscriberImport";
import { loadExcelJS } from "@/lib/lazy-report-deps";

const state = vi.hoisted(() => ({ mutate: vi.fn(), onSaved: vi.fn().mockResolvedValue(undefined), toastError: vi.fn(), options: null as null | { onSuccess: (value: { created: Array<{ sourceRow: number; fullName: string; subscriberNo: string }>; updated: Array<{ sourceRow: number; fullName: string; subscriberNo: string }>; failed: Array<{ sourceRow: number; fullName: string; reason: string }>; message: string }) => Promise<void> } }));


vi.mock("@/lib/trpc", () => ({ trpc: { powerhub: { subscribers: { bulkImport: { useMutation: (options: typeof state.options) => { state.options = options; return { mutate: state.mutate, isPending: false }; } } } } } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: state.toastError } }));

describe("استيراد المشتركين من Excel", () => {
  afterEach(() => { cleanup(); state.mutate.mockReset(); state.onSaved.mockClear(); state.toastError.mockReset(); state.options = null; });

  it("يعرض مدخل الملف والقالب مع توضيح أن الرقم المرجعي للتحديث فقط", () => {
    render(<BulkSubscriberImport siteId={7} onSaved={state.onSaved} />);
    expect(screen.getByText("إضافة مشتركين جماعياً")).toBeInTheDocument();
    expect(screen.getByText(/الرقم المرجعي في الملف يُستخدم فقط عند تفعيل تحديث/)).toBeInTheDocument();
    expect(screen.getByText("تنزيل القالب")).toBeInTheDocument();
    expect(screen.getByLabelText("رفع ملف Excel", { selector: "input" })).toHaveAttribute("accept", expect.stringContaining(".xlsx"));
  });

  it("لا يرسل الرقم المرجعي عند إنشاء مشترك جديد، ويترك رقم المشترك للخادم", async () => {
    const { default: ExcelJS } = await loadExcelJS();
    const sourceWorkbook = new ExcelJS.Workbook();
    const sourceSheet = sourceWorkbook.addWorksheet("استيراد المشتركين");
    sourceSheet.addRow(["الاسم الكامل", "رقم الجوال الدولي", "العنوان", "نوع الاشتراك", "الرقم المرجعي", "القراءة الافتتاحية", "تاريخ القراءة الافتتاحية"]);
    sourceSheet.addRow(["أحمد العلي", "+970599000001", "غزة", "سكني", "SUB-NORTH-001", 12.52, "2026-10-10"]);
    sourceSheet.addRow(["", "", "", "", "", 99.25]);
    const workbookBuffer = await sourceWorkbook.xlsx.writeBuffer();
    const uploadFile = {
      name: "subscribers.xlsx",
      arrayBuffer: vi.fn().mockResolvedValue(workbookBuffer),
    } as unknown as File;
    render(<BulkSubscriberImport siteId={7} onSaved={state.onSaved} />);
    const uploadInput = screen.getByLabelText("رفع ملف Excel", { selector: "input" });
    Object.defineProperty(uploadInput, "files", { configurable: true, value: [uploadFile] });
    fireEvent.change(uploadInput);
    await vi.waitFor(() => expect(screen.getByText("أحمد العلي")).toBeInTheDocument());
    expect(state.toastError).not.toHaveBeenCalled();
    expect(screen.getByText("12.52")).toBeInTheDocument();
    expect(screen.getByText("99.25")).toBeInTheDocument();
    expect(screen.getByText(/أدخل الاسم الكامل/)).toBeInTheDocument();
    expect(screen.getByText(/سيُحفظ الملف كاملاً داخل معاملة ذرية/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /حفظ 1 مشتركاً سليماً/ }));
    expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 7,
      updateExisting: false,
      clientOperationId: expect.any(String),
      approveOpeningReadings: true,
      rows: [{ sourceRow: 2, subscriberNo: undefined, fullName: "أحمد العلي", phone: "+970599000001", whatsappNumber: undefined, address: "غزة", subscriptionType: "residential", openingReading: "12.52", openingReadingAt: expect.any(String) }],
    }));
  });
});