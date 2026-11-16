// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CreateSubaccountForm from "./CreateSubaccountForm";
import { powerCapabilityLabels, type PowerCapability } from "@shared/powerhub-rbac";

const rights: PowerCapability[] = [
  "manageSubscribers","recordReadings","collectPayments","viewFinancialReports",
  "manageTeam","manageMessaging",
];
const available: PowerCapability[] = ["manageSubscribers","recordReadings","collectPayments","viewFinancialReports"];
const sites = [
  { id: 101, tenantId: 10, name: "الفرع الرئيسي" },
  { id: 102, tenantId: 10, name: "الفرع الثاني" },
];
const props = {
  initialSiteId: 101,
  sites,
  roles: ["accountant","collector","technician"] as const,
  ownerCapabilities: rights,
  availableCapabilities: available,
  canUseAllBranches: true,
  isCatalogLoading: false,
  isCatalogError: false,
  isSaving: false,
  onCreate: vi.fn(),
};
const label = (key: PowerCapability) => screen.getByRole("checkbox",{name:powerCapabilityLabels[key]});

describe("E47 إنشاء حساب فرعي مع صلاحيات قابلة للتخصيص", () => {
  it("loads accountant defaults, permits removing and adding a right without owner-only escalation", () => {
    const onCreate = vi.fn();
    render(<CreateSubaccountForm {...props} roles={[...props.roles]} onCreate={onCreate} />);
    expect(label("collectPayments")).toBeChecked();
    expect(label("viewFinancialReports")).toBeChecked();
    expect(screen.queryByText(powerCapabilityLabels.manageTeam)).not.toBeInTheDocument();
    expect(screen.queryByText(powerCapabilityLabels.manageMessaging)).not.toBeInTheDocument();

    fireEvent.click(label("collectPayments"));
    expect(label("collectPayments")).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("الدور الافتراضي للحساب الفرعي"), {target:{value:"collector"}});
    expect(label("collectPayments")).toBeChecked();
    expect(label("viewFinancialReports")).not.toBeChecked();
    fireEvent.click(label("collectPayments"));
    fireEvent.click(label("viewFinancialReports"));
    expect(label("collectPayments")).not.toBeChecked();
    expect(label("viewFinancialReports")).toBeChecked();
    fireEvent.change(screen.getByLabelText("الفرع المسموح للمستخدم"), {target:{value:"102"}});
    fireEvent.click(screen.getByLabelText("صلاحية جميع الأفرع"));
    fireEvent.change(screen.getByPlaceholderText("الاسم الكامل للمستخدم"),{target:{value:"محصل تجريبي"}});
    fireEvent.change(screen.getByPlaceholderText("accountant@example.com"),{target:{value:"staff@example.test"}});
    fireEvent.change(screen.getByLabelText("كلمة المرور المؤقتة"),{target:{value:"Temporary123!"}});
    fireEvent.click(screen.getByRole("button",{name:/إنشاء الحساب الفرعي بالصلاحيات المختارة/}));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      siteId:102,name:"محصل تجريبي",email:"staff@example.test",
      temporaryPassword:"Temporary123!",role:"collector",allBranches:true,
      permissions:["viewFinancialReports"],
    });
  });

  it("restores the selected role's defaults, and hides all branches without entitlement", () => {
    render(<CreateSubaccountForm {...props} roles={[...props.roles]} canUseAllBranches={false}/>);
    expect(screen.queryByLabelText("صلاحية جميع الأفرع")).not.toBeInTheDocument();
    fireEvent.click(label("viewFinancialReports"));
    expect(label("viewFinancialReports")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button",{name:"استعادة الافتراضي"}));
    expect(label("viewFinancialReports")).toBeChecked();
  });

  it("remains fail-closed while capability verification fails or is loading", () => {
    const onCreate=vi.fn();
    const {rerender}=render(<CreateSubaccountForm {...props} roles={[...props.roles]}
      onCreate={onCreate} isCatalogLoading={true} availableCapabilities={[]} />);
    expect(screen.getByRole("button",{name:/إنشاء الحساب الفرعي بالصلاحيات المختارة/})).toBeDisabled();
    rerender(<CreateSubaccountForm {...props} roles={[...props.roles]} onCreate={onCreate}
      isCatalogError={true} availableCapabilities={[]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("تعذر التحقق من صلاحيات المالك");
    expect(screen.getByRole("button",{name:/إنشاء الحساب الفرعي بالصلاحيات المختارة/})).toBeDisabled();
    rerender(<CreateSubaccountForm {...props} roles={[...props.roles]} onCreate={onCreate} />);
    expect(label("collectPayments")).toBeChecked();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("does not silently reset a user-removed permission when the catalog refreshes", () => {
    const {rerender}=render(<CreateSubaccountForm {...props} roles={[...props.roles]}/>);
    fireEvent.click(label("viewFinancialReports"));
    expect(label("viewFinancialReports")).not.toBeChecked();
    rerender(<CreateSubaccountForm {...props} roles={[...props.roles]}
      availableCapabilities={[...available]} />);
    expect(label("viewFinancialReports")).not.toBeChecked();
  });
});
