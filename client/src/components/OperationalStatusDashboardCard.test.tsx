// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OperationalStatusDashboardCard } from "./OperationalStatusDashboardCard";

describe("OperationalStatusDashboardCard", () => {
  it("يعرض المشتركين النشطين وحالتي المولدات", () => {
    render(<OperationalStatusDashboardCard subscribers={150} generators={{ active: 2, maintenance: 1 }} scopeLabel="الفرع الرئيسي" />);
    expect(screen.getByText("المشتركون والمولدات")).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("توجد صيانة")).toBeInTheDocument();
  });

  it("يعرض هيكل تحميل واضحاً أثناء انتظار البيانات", () => {
    render(<OperationalStatusDashboardCard subscribers={0} loading />);
    expect(screen.getByLabelText("ملخص الحالة التشغيلية")).toBeInTheDocument();
  });
});
