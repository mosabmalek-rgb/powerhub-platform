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
  "/inventory": { capabilities: [
    "viewInventory", "viewInventoryReports", "viewSuppliers", "viewPurchases",
    "manageInventoryItems", "manageSuppliers", "createPurchases", "approvePurchases",
    "receiveInventory", "man¶»§q«^