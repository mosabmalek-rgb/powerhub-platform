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
      performance: {
        collectorPerformance: {
          useQuery: () => ({
            data: {
              openCount: 1,
              closedCount: 2,
              varianceCount: 1,
              netVariance: -2,
              collectors: [
                { name: "أحمد", sessions: 2, variance: -2 },
                { name: "محمد", sessions: 1, variance: 0 },
              ],
            },
            isLoading: false,
            isError: false,
          }),
        },
        allBranchesCollectorPerformance: {
          useQuery: () => ({
            data: { openCount: 0, closedCount: 0, varianceCount: 0, netVariance: 0, collectors: [] },
            isLoading: false,
            isError: false,
          }),
        },
      },
    },
  },
}));

describe("CollectorPerformanceSection", () => {
  it("يعرض الجلسات والتنبيهات وأداء المحصلين", () => {
    render(<CollectorPerformanceSection siteId={1} scope="branch" from="2026-09-01" to="2026-09-06" />);
    expect(screen.getByText("الجلسات المفتوحة")).toBeInTheDocument();
    expect(screen.getByText("تنبيهات فروقات النقد")).toBeInTheDocument();
    expect(screen.getByText("أحمد")).toBeInTheDocument();
    expect(screen.getByText("تحتاج مراجعة")).toBeInTheDocument();
  });
});