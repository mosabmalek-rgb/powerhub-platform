export type SubscriberImportDraft = {
  sourceRow?: number;
  subscriberNo?: string;
  fullName: string;
  phone: string;
  whatsappNumber?: string;
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

function subscriberReferenceKey(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, "").trim().toUpperCase();
}

export function prepareSubscriberImport(rows: SubscriberImportDraft[]): PreparedSubscriberImportRow[] {
  const phones = new Map<string, number>();
  const references = new Map<string, number>();
  rows.forEach((row, index) => {
    const key = phoneKey(row.phone);
    if (key) phones.set(key, (phones.get(key) ?? 0) + 1);
    const reference = subscriberReferenceKey(row.subscriberNo);
    if (reference) references.set(reference, (references.get(reference) ?? 0) + 1);
    void index;
  });
  return rows.map((row, index) => {
    const errors: string[] = [];
    const name = row.fullName.trim();
    const phone = phoneKey(row.phone);
    const whatsappNumber = phoneKey(row.whatsappNumber ?? "");
    const subscriberNo = subscriberReferenceKey(row.subscriberNo);
    const normalizedSubscriptionType = subscriptionType(row.subscriptionType);
    if (name.length < 2) errors.push("أدخل الاسم الكامل (حرفان على الأقل).");
    if (!/^\+?[0-9]{5,30}$/.test(phone)) errors.push("أدخل رقم جوال بأرقام واضحة مع رمز الدولة، مثل +970….");
    if (whatsappNumber && !/^\+?[0-9]{5,30}$/.test(whatsappNumber)) errors.push("رقم واتساب اختياري، لكن يجب أن يكون رقماً صحيحاً عند إدخاله.");
    if (!normalizedSubscriptionType) errors.push("نوع الاشتراك يجب أن يكون سكني أو تجاري.");
    if (phone && (phones.get(phone) ?? 0) > 1) errors.push("رقم الجوال مكرر داخل الملف.");
    if (subscriberNo && !/^[A-Z0-9][A-Z0-9_-]{1,79}$/.test(subscriberNo)) errors.push("الرقم المرجعي يجب أن يحتوي أحرفاً أو أرقاماً وشرطات فقط.");
    if (subscriberNo && (references.get(subscriberNo) ?? 0) > 1) errors.push("الرقم المرجعي مكرر داخل الملف.");
    return { ...row, subscriberNo: subscriberNo || undefined, rowNumber: row.sourceRow ?? index + 2, normalizedSubscriptionType, status: errors.length ? "error" : "ready", errors };
  });
}
