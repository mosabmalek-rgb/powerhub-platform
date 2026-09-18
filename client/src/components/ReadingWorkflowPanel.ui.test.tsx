// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReadingWorkflowPanel from "./ReadingWorkflowPanel";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  createAndIssue: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    powerhub: {
      readings: {
        create: { useMutation: () => ({ mutateAsync: state.create, isPending: false }) },
        createAndIssue: { useMutation: () => ({ mutateAsync: state.createAndIssue, isPending: false }) },
      },
      tariffs: { list: { useQuery: () => ({ data: [{ id: 1, isActive: true }], isLoading: false }) } },
    },
  },
}));

afterEach(() => {
  cleanup();
  state.create.mockReset();
  state.createAndIssue.mockReset();
});

describe("ReadingWorkflowPanel", () => {
  it("uses the atomic create-and-issue mutation for the immediate invoice action", async () => {
    state.createAndIssue.mockResolvedValue({
      id: 11,
      consumptionKwh: 10,
      status: "approved",
      invoiceId: 21,
      invoiceNo: "INV-00021",
      totalAmount: 50,
      notificationIds: [],
      replayed: false,
      alreadyProcessed: false,
    });

    render(
      <ReadingWorkflowPanel
        siteId={1}
        role="owner"
        subscribers={[{ id: 5, fullName: "مشترك تجريبي", subscriberNo: "SUB-0001" }]}
        readings={[]}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "5" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "القراءة الحالية" }), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ وإصدار فاتورة" }));

    await waitFor(() => expect(state.createAndIssue).toHaveBeenCalledTimes(1));
    expect(state.create).not.toHaveBeenCalled();
    expect(state.createAndIssue).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 1,
      subscriberId: 5,
      readingValue: "120",
    }));
  });
});
