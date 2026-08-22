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
  | "approveReadings"
  | "manageTariffs"
  | "issueInvoices"
  | "collectPayments"
  | "manageExpenses"
  | "manageTeam"
  | "manageMessaging"
  | "viewAudit";

export const powerRoleLabels: Record<PowerRole, string> = {
  owner: "صاحب مولد",
  manager: "مدير",
  accountant: "محاسب",
  collector: "محصل",
  technician: "فني",
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
  approveReadings: ["owner", "manager", "accountant"],
  manageTariffs: ["owner", "manager", "accountant"],
  issueInvoices: ["owner", "manager", "accountant"],
  collectPayments: ["owner", "manager", "accountant", "collector"],
  manageExpenses: ["owner", "manager", "accountant"],
  manageTeam: ["owner"],
  manageMessaging: ["owner"],
  viewAudit: ["owner", "manager", "accountant", "viewer"],
};

export const powerCapabilityLabels: Record<PowerCapability, string> = {
  manageSubscribers: "إدارة المشتركين",
  manageGenerators: "إدارة المولدات",
  recordReadings: "تسجيل القراءات",
  approveReadings: "اعتماد القراءات",
  manageTariffs: "إدارة التعرفات",
  issueInvoices: "إصدار الفواتير",
  collectPayments: "تسجيل التحصيلات",
  manageExpenses: "إدارة المصروفات",
  manageTeam: "إدارة الحسابات الفرعية",
  manageMessaging: "إدارة الإشعارات والقوالب",
  viewAudit: "عرض سجل التدقيق",
};

export function can(role: PowerRole | undefined | null, capability: PowerCapability, permissions?: readonly PowerCapability[] | null) {
  if (permissions?.length) return permissions.includes(capability);
  return Boolean(role && capabilityRoles[capability].includes(role));
}

export function rolesWith(capability: PowerCapability): PowerRole[] {
  return [...capabilityRoles[capability]];
}
