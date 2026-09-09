export type OfflineCrudEntity = "subscribers" | "generators" | "readings" | "tariffs" | "schedules" | "sites";
export type OfflineCrudAction = "create" | "update" | "delete";

const safeCreate = new Set<OfflineCrudEntity>(["subscribers", "generators", "readings"]);
const safeUpdate = new Set<OfflineCrudEntity>(["subscribers", "generators", "readings", "tariffs", "schedules"]);
const safeDelete = new Set<OfflineCrudEntity>([]);

export function isOfflineCrudAllowed(entity: OfflineCrudEntity, action: OfflineCrudAction) {
  if (action === "create") return safeCreate.has(entity);
  if (action === "update") return safeUpdate.has(entity);
  return safeDelete.has(entity);
}

export function assertOfflineCrudAllowed(entity: OfflineCrudEntity, action: OfflineCrudAction) {
  if (!isOfflineCrudAllowed(entity, action)) {
    throw new Error(`العملية ${action} للكيان ${entity} غير مسموحة دون اتصال.`);
  }
}

export const OFFLINE_CRUD_POLICY = Object.freeze({
  create: Object.freeze(Array.from(safeCreate)),
  update: Object.freeze(Array.from(safeUpdate)),
  delete: Object.freeze(Array.from(safeDelete)),
  blockedByDefault: Object.freeze([
    "invoices",
    "payments",
    "collections",
    "expenses",
    "payroll",
    "attendance",
    "notifications",
    "audit",
    "admin",
    "messaging",
    "companyAccounts",
    "financialDashboard",
    "financialSettlements",
    "authorization",
  ]),
});
