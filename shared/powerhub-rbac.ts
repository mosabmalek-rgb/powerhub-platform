export type PowerRole = "owner" | "manager" | "accountant" | "collector" | "technician" | "viewer";

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
  owner: "مالك",
  manager: "مدير",
  accountant: "محاسب",
  collector: "محصل",
  technician: "فني",
  viewer: "مشاهد",
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

export function can(role: PowerRole | undefined | null, capability: PowerCapability) {
  return Boolean(role && capabilityRoles[capability].includes(role));
}

export function rolesWith(capability: PowerCapability): PowerRole[] {
  return [...capabilityRoles[capability]];
}
