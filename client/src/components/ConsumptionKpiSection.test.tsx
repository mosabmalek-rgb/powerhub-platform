// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConsumptionKpiSection from "./ConsumptionKpiSection";

const state = vi.hoisted(() => ({
  branchQuery: vi.fn(),
  allBranchesQuery: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    powerhub: {
      performance: {
        readingKpis: { useQuery: state.branchQuery },
        allBranchesReadingKpis: { useQuery: state.allBranchesQuery },
      },
    },
  },
}));

const branchData = {
  consumption: 12.5,
  average: 12.5,
  approvedCount: 1,
  pendingCount: 2,
  latestReadingAt: "2026-10-05T10:00:00.000Z",
};
const allBranchesData = {
  consumption: 30,
  average: 15,
  approvedCount: 2,
  pendingCount: 1,
  latestReadingAt: "2026-10-06T10:00:00.000Z",
};

describe("ConsumptionKpiSection dashboard scope", () => {
  beforeEach(() => {
    state.branchQuery.mockReturnValue({ data: branchData, isLoading: false, isError: false });
    state.allBranchesQuery.mockReturnValue({ data: allBranchesData, isLoading: false, isError: false });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads branch KPIs only for the currently selected branch", () => {
    render(<ConsumptionKpiSection siteId={11} scope="branch" from="2026-10-01" to="2026-10-07" />);

    expect(state.branchQuery).toHaveBeenCalledWith(
      { siteId: 11, from: "2026-10-01", to: "2026-10-07" },
      expect.objectContaining({ enabled: true }),
    );
    expect(state.allBranchesQuery).toHaveBeenCalledWith(
      { siteId: 11, from: "2026-10-01", to: "2026-10-07" },
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.getByRole("region", { name: "مؤشرات الاستهلاك والقراءات" })).toHaveTextContent("12.5");
    expect(screen.getByText(/الفرع المحدد/)).toBeInTheDocument();
  });

  it("loads tenant-wide aggregates only in all-branches scope and removes misleading average KPI", () => {
    render(<ConsumptionKpiSection siteId={11} scope="all" from="2026-10-01" to="2026-10-07" />);

    expect(state.branchQuery).toHaveBeenCalledWith(
      { siteId: 11, from: "2026-10-01", to: "2026-10-07" },
      expect.objectContaining({ enabled: false }),
    );
    expect(state.allBranchesQuery).toHaveBeenCalledWith(
      { siteId: 11, from: "2026-10-01", to: "2026-10-07" },
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByRole("region", { name: "مؤشرات الاستهلاك والقراءات" })).toHaveTextContent("30");
    expect(screen.getByText(/جميع الأفرع غير المؤرشفة/)).toBeInTheDocument();
    expect(screen.getByText(/آخر قراءة معتمدة ضمن الفترة/)).toBeInTheDocument();
    expect(screen.queryByText(/متوسط الاستهلاك/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: /الاستهلاك|القراءات/ }).length).toBeGreaterThan(0);
  });

  it("does not query data when the dashboard is disabled or no anchor branch is available", () => {
    const { rerender } = render(<ConsumptionKpiSection siteId={null} scope="all" enabled />);
    expect(state.branchQuery).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 0 }),
      expect.objectContaining({ enabled: false }),
    );
    expect(state.allBranchesQuery).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 0 }),
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.queryByRole("region", { name: "مؤشرات الاستهلاك والقراءات" })).not.toBeInTheDocument();

    rerender(<ConsumptionKpiSection siteId={11} scope="all" enabled={false} />);
    expect(state.allBranchesQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ siteId: 11 }),
      expect.objectContaining({ enabled: false }),
    );
  });
});
