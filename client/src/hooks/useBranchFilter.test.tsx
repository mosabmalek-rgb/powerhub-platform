// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BRANCH_FILTER_STORAGE_KEY, useBranchFilter } from "./useBranchFilter";

function Probe({ branches }: { branches: { id: number }[] }) {
  const { branchId, setBranchId } = useBranchFilter(branches);
  return <><output data-testid="branch-id">{branchId ?? ""}</output><button onClick={() => setBranchId(2)}>تغيير الفرع</button></>;
}

afterEach(() => { cleanup(); window.localStorage.clear(); });

describe("useBranchFilter", () => {
  it("يستخدم الفرع المحفوظ عندما يكون ضمن الفروع المصرح بها ويحفظ التبديل الجديد", () => {
    window.localStorage.setItem(BRANCH_FILTER_STORAGE_KEY, "2");
    render(<Probe branches={[{ id: 1 }, { id: 2 }]} />);
    expect(screen.getByTestId("branch-id")).toHaveTextContent("2");
    fireEvent.click(screen.getByRole("button", { name: "تغيير الفرع" }));
    expect(window.localStorage.getItem(BRANCH_FILTER_STORAGE_KEY)).toBe("2");
  });

  it("يستبدل القيمة المخزنة غير المصرح بها بأول فرع مسموح", () => {
    window.localStorage.setItem(BRANCH_FILTER_STORAGE_KEY, "999");
    render(<Probe branches={[{ id: 3 }, { id: 4 }]} />);
    expect(screen.getByTestId("branch-id")).toHaveTextContent("3");
    expect(window.localStorage.getItem(BRANCH_FILTER_STORAGE_KEY)).toBe("3");
  });
});
