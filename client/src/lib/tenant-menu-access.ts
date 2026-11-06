import { can, type PowerCapability, type PowerRole } from "@shared/powerhub-rbac";

type TenantMenuRule = {
  roles?: readonly PowerRole[];
  capability?: PowerCapability;
  capabilities?: readonly PowerCapability[];
};

const READ_ROLES = {
  subscribers: ["owner", "manager", "accountant", "collector", "viewer"],
  generators: ["owner", "manager", "technician", "viewer"],
  readings: ["owner", "manager", "accountant", "collector", "technician", "viewer"],
  mobileSync: ["owner", "manager", "accountant", "viewer"],
  audit: ["owner", "manager", "accountant", "viewer"],
  humanResources: ["owner", "manager", "accountant"],
  attendance: ["owner", "manager", "accountant"],
} as const satisfies Record<string, readonly PowerRole[]>;

const TENANT_MENU_RULES: Record<string, TenantMenuRule> = {
  "/workspace": {},
  "/inventory": { capabilities: [
    "viewInventory", "viewInventoryReports", "viewSuppliers", "viewPurchases",
    "manageInventoryItems", "manageSuppliers", "createPurchases", "approvePurchases",
    "receiveInventory", "manageSupplierPayments", "viewSupplierLedger",
    "issueInventory", "adjustInventory", "manageFuelAndConsumption", "manageMaintenance",
    "viewStocktakes", "manageStocktakes", "approveStocktakes", "manageGenerators",
  ] },
  "/quick-actions": {},
  "/profile": {},
  "/announcements": {},
  "/support-chat": {},
  "/ai-support": {},
  "/offline-sync": {},
  "/subscribers": { roles: READ_ROLES.subscribers, capability: "manageSubscribers" },
  "/generators": { roles: READ_ROLES.generators },
  "/branches": { roles: ["owner"] },
  "/readings": { roles: READ_ROLES.readings },
  "/invoices": { capabilities: ["issueInvoices", "collectPayments", "viewFinancialReports"] },
  "/collections": { capabilities: ["collectPayments", "viewFinancialReports"] },
  "/company-accounts": { capabilities: ["manageExpenses", "viewFinancialReports"] },
  "/expenses": { capabilities: ["manageExpenses", "viewFinancialReports"] },
  "/financial-dashboard": { capability: "viewFinancialReports" },
  "/financial-settlements": { capability: "viewFinancialReports" },
  "/payment-documentation": {},
  "/payment-documentation/review": { capability: "approvePaymentDocumentation" },
  "/human-resources": { roles: READ_ROLES.humanResources, capability: "manageTeam" },
  "/staff": { capability: "manageTeam" },
  "/attendance": { roles: READ_ROLES.attendance, capability: "managePayroll" },
  "/payroll": { roles: ["owner", "manager", "accountant"], capability: "managePayroll" },
  "/reports": { capability: "viewFinancialReports" },
  "/notifications": { capability: "manageMessaging" },
  "/mobile-sync": { roles: READ_ROLES.mobileSync },
  "/field-distribution": { roles: ["owner"] },
  "/audit": { roles: READ_ROLES.audit, capability: "viewAudit" },
  "/portal-settings": { roles: ["owner"] },
  "/settings": { capability: "manageTeam" },
};

export function tenantMenuRouteAllowed(
  path: string,
  role: PowerRole | undefined | null,
  permissions?: readonly PowerCapability[] | null,
  usesPermissionOverride = false,
): boolean {
  const rule = TENANT_MENU_RULES[path];
  if (!rule) return false;

  if (rule.roles) {
    if (rule.roles.includes(role as PowerRole) && !usesPermissionOverride) return true;
    if (!rule.capability && !rule.roles.includes(role as PowerRole)) return false;
  }
  if (rule.capabilities) return rule.capabilities.some((capability) => can(role, capability, permissions));
  if (rule.capability) return can(role, rule.capability, permissions);
  return Boolean(role);
}

/** Branch navigation is a feature/limit decision, not a count-of-existing-sites decision. */
export function shouldShowBranchManagement(
  policy: { isEnabled?: boolean; maxBranches?: number | null } | null | undefined,
  platformRole?: string | null,
): boolean {
  if (platformRole === "admin") return true;
  return policy?.isEnabled === true &&
    typeof policy.maxBranches === "number" &&
    Number.isFinite(policy.maxBranches) &&
    policy.maxBranches > 1;
}
