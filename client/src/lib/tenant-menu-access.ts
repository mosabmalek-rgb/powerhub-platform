import {
  defaultCapabilitiesForRole, type PowerCapability, type PowerRole,
} from "@shared/powerhub-rbac";

type TenantMenuRule = {
  roles?: readonly PowerRole[];
  capability?: PowerCapability;
  capabilities?: readonly PowerCapability[];
  ownerOnly?: boolean;
  // Informational/account tools are not operational capabilities. For staff
  // with E47 explicit permissions, avoid showing unrelated sidebar tabs.
  legacyStaffOnly?: boolean;
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

const INVENTORY_CAPABILITIES: readonly PowerCapability[] = [
  "viewInventory", "viewInventoryReports", "viewSuppliers", "viewPurchases",
  "manageInventoryItems", "manageSuppliers", "createInventoryItems",
  "editInventoryItems", "deactivateInventoryItems", "createSuppliers",
  "editSuppliers", "deactivateSuppliers", "createWarehouses",
  "editWarehouses", "deactivateWarehouses", "createPurchases",
  "approvePurchases", "receiveInventory", "manageSupplierPayments",
  "reverseSupplierPayments", "viewSupplierLedger", "issueInventory",
  "adjustInventory", "manageFuelAndConsumption", "manageMaintenance",
  "viewStocktakes", "manageStocktakes", "approveStocktakes",
];

const ACTION_CAPABILITIES: readonly PowerCapability[] = [
  "manageSubscribers", "recordReadings", "approveReadings", "issueInvoices",
  "collectPayments", "manageExpenses", "manageMessaging",
];

const TENANT_MENU_RULES: Record<string, TenantMenuRule> = {
  "/workspace": { legacyStaffOnly: true },
  "/quick-actions": { legacyStaffOnly: true },
  "/profile": {},
  "/notifications-center": {},
  "/announcements": { legacyStaffOnly: true },
  "/support-chat": { legacyStaffOnly: true },
  "/ai-support": { legacyStaffOnly: true },
  "/offline-sync": { capabilities: [
    "manageSubscribers", "recordReadings", "approveReadings", "issueInvoices",
    "collectPayments", "manageExpenses", "receiveInventory",
  ] },
  "/subscribers": { roles: READ_ROLES.subscribers, capabilities: ["manageSubscribers", "collectPayments"] },
  "/subscriber-statement": { roles: READ_ROLES.subscribers, capabilities: [
    "manageSubscribers", "collectPayments", "viewFinancialReports",
  ] },
  "/generators": { roles: READ_ROLES.generators, capabilities: [
    "manageGenerators", "recordReadings", "accessFieldApp",
  ] },
  "/branches": { ownerOnly: true },
  "/readings": { roles: READ_ROLES.readings, capabilities: [
    "recordReadings", "approveReadings", "issueInvoices",
  ] },
  "/invoices": { capabilities: ["issueInvoices", "collectPayments", "viewFinancialReports"] },
  "/collections": { capabilities: ["collectPayments", "viewFinancialReports"] },
  "/company-accounts": { capabilities: ["manageExpenses", "viewFinancialReports"] },
  "/expenses": { capabilities: ["manageExpenses", "viewFinancialReports"] },
  "/inventory": { capabilities: [...INVENTORY_CAPABILITIES, "manageGenerators"] },
  "/financial-dashboard": { capability: "viewFinancialReports" },
  "/financial-settlements": { capability: "viewFinancialReports" },
  // The submission screen calls searchSubscriber/submit, which require
  // collectPayments. Merely enabling the tenant feature is not a staff grant.
  "/payment-documentation": { capability: "collectPayments" },
  "/payment-documentation/review": { capability: "approvePaymentDocumentation" },
  "/human-resources": { roles: READ_ROLES.humanResources, capability: "manageTeam", ownerOnly: true },
  "/staff": { ownerOnly: true },
  "/attendance": { roles: READ_ROLES.attendance, capability: "managePayroll" },
  "/payroll": { roles: ["owner", "manager", "accountant"], capability: "managePayroll" },
  "/reports": { capability: "viewFinancialReports" },
  "/notifications": { capability: "manageMessaging" },
  "/mobile-sync": { roles: READ_ROLES.mobileSync, capabilities: ["approveReadings", "recordReadings"] },
  "/field-distribution": { ownerOnly: true },
  "/audit": { roles: READ_ROLES.audit, capability: "viewAudit" },
  "/portal-settings": { ownerOnly: true },
  "/settings": { ownerOnly: true },
  "/setup": { ownerOnly: true },
  "/support-center": { ownerOnly: true },
  "/internal/b5-http-acceptance": { ownerOnly: true },
  "/internal/c5-http-acceptance": { ownerOnly: true },
  "/internal/d9-http-acceptance": { ownerOnly: true },
  "/internal/d36-http-acceptance": { ownerOnly: true },
};

export function canonicalTenantRoute(path: string): string {
  const clean = path.split(/[?#]/, 1)[0].replace(/\/$/, "") || "/";
  if (/^\/subscriber-statement\/[^/]+$/.test(clean)) return "/subscriber-statement";
  if (/^\/mobile-sync\/readings\/[^/]+$/.test(clean)) return "/mobile-sync";
  return clean;
}

/**
 * One shared navigation AND page-boundary decision. Explicit E47 permissions
 * always take precedence over default role grants (including an empty array).
 * Missing permissions are treated as defaults only for legacy role accounts,
 * never for an explicit customized account.
 */
export function tenantMenuRouteAllowed(
  path: string,
  role: PowerRole | undefined | null,
  permissions?: readonly PowerCapability[] | null,
  usesPermissionOverride = false,
): boolean {
  if (!role) return false;
  const rule = TENANT_MENU_RULES[canonicalTenantRoute(path)];
  if (!rule) return false;
  if (rule.ownerOnly && role !== "owner") return false;
  if (rule.roles && !rule.roles.includes(role) && !usesPermissionOverride) return false;

  const effective = permissions ?? (usesPermissionOverride ? [] : defaultCapabilitiesForRole(role));
  if (rule.legacyStaffOnly) return role === "owner" || !usesPermissionOverride;
  if (rule.capabilities) return role === "owner" || rule.capabilities.some((capability) => effective.includes(capability));
  if (rule.capability) return effective.includes(rule.capability);
  // Only non-operational account and notification screens have no capability.
  return true;
}

/** Keep an E47 single-permission user out of the unrelated overview on login. */
export function firstPermittedTenantRoute(
  role: PowerRole,
  permissions: readonly PowerCapability[],
  usesPermissionOverride = false,
): string | null {
  const order = [
    "/workspace", "/payment-documentation/review", "/payment-documentation",
    "/subscribers", "/readings", "/invoices", "/collections", "/inventory",
    "/financial-dashboard", "/reports", "/expenses", "/company-accounts",
    "/generators", "/payroll", "/attendance", "/mobile-sync", "/audit",
  ];
  return order.find((path) => tenantMenuRouteAllowed(path, role, permissions, usesPermissionOverride)) ?? null;
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
