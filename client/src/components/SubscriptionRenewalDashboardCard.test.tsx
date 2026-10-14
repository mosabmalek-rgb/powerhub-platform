// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SubscriptionRenewalDashboardCard } from "./SubscriptionRenewalDashboardCard";

afterEach(cleanup);

function renderCard(endsAt: Date, overrides: Record<string, unknown> = {}) {
  const onContact = vi.fn();
  render(<SubscriptionRenewalDashboardCard
    data={{ isOwner: true, subscription: {
      packageCode: "advanced", status: "active", billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"), endsAt, autoRenew: false,
      readOnlyUntil: null, renewalCount: 1, ...overrides,
    } as any }}
    loading={false} error={false} ownerAccessVerified={false} onRetry={vi.fn()} onContact={onContact}
  />);
  return onContact;
}

describe("بطاقة اشتراك صاحب المولد", () => {
  it("تعرض الباقة وتاريخ الانتهاء ووسيلة طلب التجديد", () => {
    const onContact = renderCard(new Date(Date.now() + 40 * 86_400_000));
    expect(screen.getByRole("heading", { name: "اشتراكي وتجديدي" })).toBeInTheDocument();
    expect(screen.getByText("النمو")).toBeInTheDocument();
    expect(screen.getByText("الباقة الحالية:", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("تاريخ الانتهاء")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "التواصل لطلب التجديد" }));
    expect(onContact).toHaveBeenCalledOnce();
  });

  it("تعرض تنبيه التجديد عندما يتبقى ثلاثة أيام", () => {
    renderCard(new Date(Date.now() + 3 * 86_400_000));
    expect(screen.getByRole("status")).toHaveTextContent(/بقي على انتهاء اشتراكك 3 أيام/);
  });

  it("تعرض تنبيه الانتهاء عند انتهاء الاشتراك الفعلي", () => {
    renderCard(new Date(Date.now() - 60_000));
    expect(screen.getByText(/انتهى اشتراكك/)).toBeInTheDocument();
    expect(screen.getByText("انتهى الاشتراك")).toBeInTheDocument();
  });

  it("لا تكشف معلومات الاشتراك عن المستخدمين غير المالكين", () => {
    render(<SubscriptionRenewalDashboardCard data={{ isOwner: false, subscription: null }} loading={false} error={false} ownerAccessVerified={false} onRetry={vi.fn()} onContact={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: "اشتراكي وتجديدي" })).not.toBeInTheDocument();
  });
});
