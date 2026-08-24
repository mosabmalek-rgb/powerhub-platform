export type SubscriberImportDraft = {
  sourceRow?: number;
  fullName: string;
  phone: string;
  address: string;
  subscriptionType: string;
};

export type PreparedSubscriberImportRow = SubscriberImportDraft & {
  rowNumber: number;
  normalizedSubscriptionType: "residential" | "commercial" | null;
  status: "ready" | "error";
  errors: string[];
};

function subscriptionType(value: string): "residential" | "commercial" | null {
  const normalized = value.trim().toLowerCase();
  if (["residential", "سكني", "سكنية"].includes(normalized)) return "residential";
  if (["commercial", "تجاري", "تجارية"].includes(normalized)) return "commercial";
  return null;
}

function phoneKey(value: string) {
  return value.replace(/[\s\-()]/g, "").trim();
}

export function prepareSubscriberImport(rows: SubscriberImportDraft[]): PreparedSubscriberImportRow[] {
  const phones = new Map<string, number>();
  rows.forEach((row, index) => {
    const key = phoneKey(row.phone);
    if (key) phones.set(key, (phones.get(key) ?? 0) + 1);
    void index;
  });
  return rows.map((row, index) => {
    const errors: string[] = [];
    const name = row.fullName.trim();
    const phone = phoneKey(row.phone);
    const normalizedSubscriptionType = subscriptionType(row.subscriptionType);
    if (name.length < 2) errors.push("أدخل الاسم الكامل (حرفان على الأقل).");
    if (!/^\+?[0-9]{5,30}$/.test(phone)) errors.push("أدخل رقم جوال بأرقام واضحة مع رمز الدولة، مثل +970….");
    if (!normalizedSubscriptionType) errors.push("نوع الاشتراك يجب أن يكون سكني أو تجاري.");
    if (phone && (phones.get(phone) ?? 0) > 1) errors.push("رقم الجوال مكرر داخل الملف.");
    return { ...row, rowNumber: row.sourceRow ?? index + 2, normalizedSubscriptionType, status: errors.length ? "error" : "ready", errors };
  });
}
