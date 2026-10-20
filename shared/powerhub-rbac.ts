export type PowerRole = "owner" | "manager" | "accountant" | "collector" | "technician" | "viewer";

export const platformAccessRole = {
  key: "super_admin",
  displayName: "مدير المنصة",
  scope: "platform",
  implementationRole: "admin",
} as const;

export type PowerCapability =
  | "manageSubscribers"
  | "manageGenerators"
  | "recordReadings"
  | "accessFieldApp"
  | "approveReadings"
  | "manageTariffs"
  | "issueInvoices"
  | "collectPayments"
  | "approvePaymentDocumentation"
  | "manageExpenses"
  | "managePayroll"
  | "manageTeam"
  | "manageMessaging"
  | "viewAudit"
  | "viewInventory"
  | "manageInventoryItems"
  | "manageSuppliers"
  | "createPurchases"
  | "approvePurchases"
  | "receiveInventory"
  | "manageSupplierPayments"
  | "viewSupplierLedger"
  | "issueInventory"
  | "adjustInventory"
  | "manageFuelAndConsumption"
  | "manageMaintenance"
  | "viewInventoryReports";

export const powerRoleLabels: Record<PowerRole, string> = {
  owner: "صاحب مولد",
  manager: "مدير",
  accountant: "محاسب",
  collector: "محصل",
  technician: "مدخل قراءة عداد (فني)",
  viewer: "مشاهد",
};

export const powerRoleScopes: Record<PowerRole, "tenant" | "site"> = {
  owner: "tenant",
  manager: "site",
  accountant: "site",
  collector: "site",
  technician: "site",
  viewer: "site",
};

const capabilityRoles: Record<PowerCapability, readonly PowerRole[]> = {
  manageSubscribers: ["owner", "manager", "accountant"],
  manageGenerators: ["owner", "manager", "technician"],
  recordReadings: ["owner", "manager", "accountant", "technician"],
  accessFieldApp: ["owner", "manager", "technician"],
  approveReadings: ["owner", "manager", "accountant"],
  manageTariffs: ["owner", "manager", "accountant"],
  issueInvoices: ["owner", "manager", "accountant"],
  collectPayments: ["owner", "manager", "accountant", "collector"],
  approvePaymentDocumentation: [],
  manageExpenses: ["owner", "manager", "accountant"],
  managePayroll: ["owner", "accountant"],
  manageTeam: ["owner"],
  manageMessaging: ["owner"],
  viewAudit: ["owner", "manager", "accountant", "viewer"],
  viewInventory: ["owner", "manager", "accountant", "technician", "viewer"],
  manageInventoryItems: ["owner", "manager"],
  manageSuppliers: ["owner", "manager", "accountant"],
  createPurchases: ["owner", "manager", "accountant"],
  approvePurchases: ["owner", "manager", "accountant"],
  receiveInventory: ["owner", "manager", "accountant", "technician"],
  manageSupplierPayments: ["owner", "accountant"],
  viewSupplierLedger: ["owner", "manager", "accountant"],
  issueInventory: ["owner", "manager", "technician"],
  adjustInventory: ["owner", "manager"],
  manageFuelAndConsumption: ["owner", "manager", "technician"],
  manageMaintenance: ["owner", "manager", "technician"],
  viewInventoryReports: ["owner", "manager", "accountant", "viewer"],
};

export const powerCapabilityLabels: Record<PowerCapability, string> = {
  manageSubscribers: "إدارة المشتركين",
  manageGenerators: "إدارة المولدات",
  recordReadings: "تسجيل القراءات",
  accessFieldApp: "الدخول للتطبيق الميداني",
  approveReadings: "اعتماد القراءات",
  manageTariffs: "إدارة التعرفات",
  issueInvoices: "إصدار الفواتير",
  collectPayments: "تسجيل التحصيلات",
  approvePaymentDocumentation: "اعتماد توثيق الدفع الإلكتروني",
  manageExpenses: "إدارة المصروفات",
  managePayroll: "اعتماد وصرف الرواتب",
  manageTeam: "إدارة الحسابات الفرعية",
  manageMessaging: "إدارة الإشعارات والقوالب",
  viewAudit: "عرض سجل التدقيق",
  viewInventory: "عرض المخزون",
  manageInventoryItems: "إدارة دليل الأصناف والمستودعات",
  manageSuppliers: "إدارة الموردين",
  createPurchases: "إنشاء فواتير المشتريات",
  approvePurchases: "اعتماد المشتريات",
  receiveInventory: "تأكيد استلام الأصناف",
  manageSupplierPayments: "تسجيل واعتماد دفعات الموردين",
  viewSupplierLedger: "عرض ذمم وكشوف الموردين",
  issueInventory: "صرف الأصناف للمولدات",
  adjustInventory: "الجرد والتسويات المخزنية",
  manageFuelAndConsumption: "إدارة الوقود والاستهلاك",
  manageMaintenance: "إدارة أوامر الصيانة",
  viewInventoryReports: "عرض وتصدير تقارير المخزون",
};

export function can(role: PowerRole | undefined | null, capability: PowerCapability, permissions?: readonly PowerCapability[] | null) {
  if (permissions !== undefined && permissions !== null) return permissions.includes(capability);
  return Boolean(role && capabilityRoles[capability].includes(role));
}

export function defaultCapabilitiesForRole(role: PowerRole | undefined | null): PowerCapability[] {
  if (!role) return [];
  return (Object.keys(capabilityRoles) as PowerCapability[]).filter((capability) => capabilityRoles[capability].includes(role));
}

export function rolesWith(capability: PowerCapability): PowerRole[] {
  return [...capabilityRoles[capability]];
}

export function applyStaffCapabilityOverrides(
  basePermissions: readonly PowerCapability[],
  overrides: readonly { capability: string; is_allowed: boolean }[],
): PowerCapability[] {
  const permissions = new Set<PowerCapability>(basePermissions);
  for (const override of overrides) {
    if (!Object.prototype.hasOwnProperty.call(powerCapabilityLabels, override.capability)) continue;
    const capability = override.capability as PowerCapability;
    if (override.is_allowed) permissions.add(capability);
    else permissions.delete(capability);
  }
  return [...permissions];
}
