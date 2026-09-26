// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriberQuotaDashboardCard } from "./SubscriberQuotaDashboardCard";

describe("SubscriberQuotaDashboardCard", () => {
  afterEach(() => cleanup());

  it("يعرض تنبيه الاقتراب عند تجاوز 80% من الحصة", () => {
    render(<SubscriberQuotaDashboardCard quota={{ plan: "professional", limit: 500, currentCount: 420, remaining: 80 }} canRequestUpgrade={false} requesting={false} onRequestUpgrade={vi.fn()}  requestingAddon={false} onRequestAddon={vi.fn()}/>);
    expect(screen.getByText("استهلكت 84% من الحد المسموح. اقتربت من الحد الأقصى.")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "84");
    expect(screen.queryByRole("button", { name: "طلب ترقية الباقة" })).not.toBeInTheDocument();
  });

  it("يظهر زر طلب الترقية وينفذ الإجراء عند بلوغ الحد", () => {
    const requestUpgrade = vi.fn();
    render(<SubscriberQuotaDashboardCard quota={{ plan: "basic", limit: 100, currentCount: 100, remaining: 0 }} canRequestUpgrade requesting={false} onRequestUpgrade={requestUpgrade}  requestingAddon={false} onRequestAddon={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: "طلب ترقية الباقة" }));
    expect(screen.getByText("اختر الباقة المطلوبة")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /باقة advanced/ }));
    expect(requestUpgrade).toHaveBeenCalledWith("advanced");
    expect(screen.getByText("بلغت الحد الأقصى للمشتركين في باقتك.")).toBeInTheDocument();
  });
});
