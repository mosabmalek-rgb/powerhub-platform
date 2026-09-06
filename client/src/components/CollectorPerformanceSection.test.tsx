// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import CollectorPerformanceSection from "./CollectorPerformanceSection";

vi.mock("@/hooks/useBranchFilter", () => ({ useBranchFilter: () => ({ branchId: 1 }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    powerhub: {
      sites: { list: { useQuery: () => ({ data: [{ id: 1, name: "فرع الاختبار" }] }) } },
      collectorSessions: {
        list: { useQuery: () => ({ data: [
          { session: { id: 1, status: "open", varianceAmount: 0, openedAt: "2026-09-05T09:00:00.000Z" }, collector: { id: 10, name: "أحمد" } },
          { session: { id: 2, status: "closed", expectedCash: 100, declaredCash: 98, varianceAmount: -2, openedAt: "2026-09-04T10:00:00.000Z", closedAt: "2026-09-04T18:00:00.000Z" }, collector: { id: 10, name: "أحمد" } },
          { session: { id: 3, status: "closed", expectedCash: 50, declaredCash: 50, varianceAmount: 0, openedAt: "2026-09-03T11:00:00.000Z", closedAt: "2026-09-03T17:00:00.000Z" }, collector: { id: 11, name: "محمد" } },
        ], isLoading: false, isError: false }) },
      },
    },
  },
}));

describe("CollectorPerformanceSection", () => {
  it("يعرض الجلسات والتنبيهات وأداء المحصلين", () => {
    render(<CollectorPerformanceSection from="2026-09-01" to="2026-09-06" />);
    expect(screen.getByText("الجلسات المفتوحة")).toBeInTheDocument();
    expect(screen.getByText("تنبيهات فروقات النقد")).toBeInTheDocument();
    expect(screen.getByText("أحمد")).toBeInTheDocument();
    expect(screen.getByText("تحتاج مراجعة")).toBeInTheDocument();
  });
});
