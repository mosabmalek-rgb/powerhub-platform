export const internationalPhoneHint = "استخدم رمز الدولة، مثل +970599000000 أو 00970599000000.";

export function normalizeInternationalPhone(value: string) {
  const compact = value.trim().replace(/[\s().-]/g, "");
  const normalized = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error(`رقم الهاتف يجب أن يكون دولياً بصيغة E.164. ${internationalPhoneHint}`);
  }
  return normalized;
}
