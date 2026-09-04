/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OwnerSubscriptionRegistration from "./OwnerSubscriptionRegistration";

describe("OwnerSubscriptionRegistration", () => {
  it("enables the form when creation is available", () => {
    const onCreate = vi.fn();
    render(<OwnerSubscriptionRegistration rows={[]} pending={false} creationAvailable onCreate={onCreate} />);
    expect(screen.getByRole("button", { name: /إنشاء اشتراك صاحب مولد/ })).toBeEnabled();
    expect(screen.queryByText(/الإنشاء متوقف انتقالياً/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/اسم الشركة/), { target: { value: "مولدات الاختبار" } });
    fireEvent.change(screen.getByPlaceholderText(/الاسم الكامل/), { target: { value: "مالك الاختبار" } });
    fireEvent.change(screen.getByPlaceholderText("رقم الهوية"), { target: { value: "12345678" } });
    fireEvent.change(screen.getByPlaceholderText("رقم الجوال"), { target: { value: "0595000000" } });
    fireEvent.change(screen.getByPlaceholderText("رقم WhatsApp"), { target: { value: "0595000000" } });
    fireEvent.change(screen.getByPlaceholderText(/البريد الإلكتروني/), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByPlaceholderText(/كلمة المرور المؤقتة/), { target: { value: "Temporary!2026" } });
    fireEvent.submit(screen.getByRole("button", { name: /إنشاء اشتراك صاحب مولد/ }).closest("form")!);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ companyName: "مولدات الاختبار", ownerEmail: "owner@example.test", plan: "starter" }));
  });
});
