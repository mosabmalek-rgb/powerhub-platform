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
  invoices: ["owner", "manager", "accountant", "collector", "viewer"],
  collections: ["owner", "manager", "accountant", "collector", "viewer"],
  expenses: ["owner", "manager", "accountant", "viewer"],
  financialDashboard: ["owner", "manager", "accountant", "viewer"],
  financialSettlements: ["owner", "manager", "accountant", "viewer"],
  reports: ["owner", "manager", "accountant", "viewer"],
  mobileSync: ["owner", "manager", "accountant", "viewer"],
  audit: ["owner", "manager", "accountant", "viewer"],
  humanResources: ["owner", "manager", "accountant"],
  attendance: ["owner", "manager", "accountant"],
  companyAccounts: ["owner", "manager", "accountant"],
} as const satisfies Record<string, readonly PowerRole[]>;

const TENANT_MENU_RULES: Record<string, TenantMenuRule> = {
  "/workspace": {},
  "/inventory": { capabilities: ["viewInventory", "viewInventoryReports"] },
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
  "/invoices": { roles: READ_ROLES.invoices },
  "/collections": { roles: READ_ROLES.collections },
  "/company-accounts": { roles: READ_ROLES.companyAccounts },
  "/expenses": { roles: READ_ROLES.expenses },
  "/financial-dashboard": { roles: READ_ROLES.financialDashboard },
  "/financial-settlements": { roles: READ_ROLES.financialSettlements },
  "/payment-documentation": {},
  "/payment-documentation/review": { capability: "approvePaymentDocumentation" },
  "/human-resources": { roles: READ_ROLES.humanResources, capability: "manageTeam" },
  "/staff": { capability: "manageTeam" },
  "/attendance": { roles: READ_ROLES.attendance, capability: "managePayroll" },
  "/payroll": { roles: ["owner", "manager", "accountant"], capability: "managePayroll" },
  "/reports": { roles: READ_ROLES.reports },
  "/notifications": { capability: "manageMessaging" },
  "/mobile-sync": { roles: READ_ROLES.mobileSync },
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
