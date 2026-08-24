// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { BulkSubscriberImport } from "./BulkSubscriberImport";

const state = vi.hoisted(() => ({ mutate: vi.fn(), onSaved: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/trpc", () => ({ trpc: { powerhub: { subscribers: { bulkImport: { useMutation: () => ({ mutate: state.mutate, isPending: false }) } } } } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("استيراد المشتركين من Excel", () => {
  it("يعرض مدخل الملف والقالب مع تحذير مراجعة البيانات قبل الإرسال", () => {
    render(<BulkSubscriberImport siteId={7} onSaved={state.onSaved} />);
    expect(screen.getByText("إضافة مشتركين جماعياً")).toBeInTheDocument();
    expect(screen.getByText(/لا تُرسل رسائل الأرقام المرجعية تلقائياً/)).toBeInTheDocument();
    expect(screen.getByText("تنزيل القالب")).toBeInTheDocument();
    expect(screen.getByLabelText("رفع ملف Excel", { selector: "input" })).toHaveAttribute("accept", expect.stringContaining(".xlsx"));
  });
});
