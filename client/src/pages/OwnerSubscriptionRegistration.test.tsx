/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);
import OwnerSubscriptionRegistration from "./OwnerSubscriptionRegistration";

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText(/اسم الشركة/), { target: { value: "مولدات الاختبار" } });
  fireEvent.change(screen.getByPlaceholderText(/الاسم الكامل/), { target: { value: "مالك الاختبار" } });
  fireEvent.change(screen.getByPlaceholderText("رقم الهوية"), { target: { value: "12345678" } });
  fireEvent.change(screen.getByPlaceholderText("رقم الجوال"), { target: { value: "0595000000" } });
  fireEvent.change(screen.getByPlaceholderText(/البريد الإلكتروني/), { target: { value: "owner@example.test" } });
  fireEvent.change(screen.getByPlaceholderText(/كلمة المرور المؤقتة/), { target: { value: "Temporary!2026" } });
}

describe("OwnerSubscriptionRegistration", () => {
  it("enables the form when creation is available", () => {
    const onCreate = vi.fn();
    render(<OwnerSubscriptionRegistration rows={[]} pending={false} creationAvailable onCreate={onCreate} />);
    expect(screen.getByRole("button", { name: /إنشاء اشتراك صاحب مولد/ })).toBeEnabled();
    expect(screen.queryByText(/الإنشاء متوقف انتقالياً/)).not.toBeInTheDocument();
    fillRequiredFields();
    fireEvent.submit(screen.getByRole("button", { name: /إنشاء اشتراك صاحب مولد/ }).closest("form")!);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ companyName: "مولدات الاختبار", ownerEmail: "owner@example.test", ownerWhatsapp: "", packageCode: "basic", subscriptionDuration: 1, trialEnabled: false, trialDurationDays: undefined }));
  });

  it("passes a custom trial duration selected by the platform admin", () => {
    const onCreate = vi.fn();
    render(<OwnerSubscriptionRegistration rows={[]} pending={false} creationAvailable onCreate={onCreate} />);
    fillRequiredFields();
    fireEvent.click(screen.getByLabelText(/تفعيل فترة تجريبية اختيارية/));
    fireEvent.change(screen.getByRole("spinbutton", { name: /مدة التجربة/ }), { target: { value: "21" } });
    fireEvent.submit(screen.getByRole("button", { name: /إنشاء اشتراك صاحب مولد/ }).closest("form")!);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ trialEnabled: true, trialDurationDays: 21 }));
  });

  it("routes the admin to subscription renewal management", () => {
    const onGoToRenewal = vi.fn();
    render(<OwnerSubscriptionRegistration rows={[]} pending={false} creationAvailable onCreate={vi.fn()} onGoToRenewal={onGoToRenewal} />);
    fireEvent.click(screen.getByRole("button", { name: /إدارة التجديدات/ }));
    expect(onGoToRenewal).toHaveBeenCalledTimes(1);
  });

  it("renders WhatsApp as optional", () => {
    render(<OwnerSubscriptionRegistration rows={[]} pending={false} creationAvailable onCreate={vi.fn()} />);
    expect(screen.getByPlaceholderText(/رقم WhatsApp/)).not.toBeRequired();
  });
});
