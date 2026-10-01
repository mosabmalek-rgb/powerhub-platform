export const internationalPhoneHint = "يمكن إدخال الرقم بصيغة 059... أو +970... أو +972... أو 00970... أو 00972...، وستوحّد PowerHub صيغة البحث والإرسال تلقائياً.";

function compactPhone(value: string) {
  return value.trim().replace(/[\s().-]/g, "");
}

function toPlus(value: string) {
  const compact = compactPhone(value);
  return compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
}

function palestinianEquivalentVariants(value: string) {
  const compact = compactPhone(value);
  const plus = toPlus(value);
  const digits = plus.startsWith("+") ? plus.slice(1) : plus;
  const variants = new Set<string>([compact, plus, digits]);

  const addPalestinianMobile = (national: string) => {
    if (!/^(56|59)\d{7}$/.test(national)) return;
    const canonical = `+970${national}`;
    variants.add(canonical);
    variants.add(canonical.slice(1));
    variants.add(`+${"972"}${national}`);
    variants.add(`972${national}`);
    variants.add(`00970${national}`);
    variants.add(`00972${national}`);
    variants.add(`0${national}`);
  };

  if (/^0(56|59)\d{7}$/.test(compact)) addPalestinianMobile(compact.slice(1));
  if (/^\+?970(56|59)\d{7}$/.test(plus)) addPalestinianMobile(plus.replace(/^\+?970/, ""));
  if (/^\+?972(56|59)\d{7}$/.test(plus)) addPalestinianMobile(plus.replace(/^\+?972/, ""));
  if (/^(56|59)\d{7}$/.test(compact)) addPalestinianMobile(compact);

  return Array.from(variants).filter(Boolean);
}

/**
 * Returns a canonical E.164 number for messaging and other external integrations.
 * Palestinian mobile numbers are accepted as 059/056, +970/970, +972/972 and 00-prefixed forms.
 * +972 is converted to +970 only for Palestinian mobile prefixes 56/59.
 */
export function normalizeInternationalPhone(value: string) {
  const normalized = toPlus(value);
  const nationalFrom970 = normalized.replace(/^\+970/, "");
  const nationalFrom972 = normalized.replace(/^\+972/, "");

  if (/^\+970(56|59)\d{7}$/.test(normalized)) return normalized;
  if (/^\+972(56|59)\d{7}$/.test(normalized)) return `+970${nationalFrom972}`;
  if (/^0(56|59)\d{7}$/.test(compactPhone(value))) return `+970${compactPhone(value).slice(1)}`;
  if (/^970(56|59)\d{7}$/.test(normalized)) return `+${normalized}`;
  if (/^972(56|59)\d{7}$/.test(normalized)) return `+970${nationalFrom972}`;

  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error(`رقم الهاتف غير صالح. ${internationalPhoneHint}`);
  }
  return normalized;
}

/**
 * Search variants for subscriber lookup. It intentionally preserves all common stored forms,
 * while treating Palestinian +970/+972/local forms as equivalent.
 */
export function phoneSearchVariants(value: string) {
  const variants = palestinianEquivalentVariants(value);
  try {
    variants.push(normalizeInternationalPhone(value));
  } catch {
    // Partial search terms such as 059, 970 or +972 are still valid lookup terms.
  }

  const unique = new Set<string>();
  for (const item of variants) {
    const compact = compactPhone(item);
    if (!compact) continue;
    unique.add(compact);
    unique.add(compact.startsWith("+") ? compact.slice(1) : `+${compact}`);
  }

  const digits = compactPhone(value).replace(/^\+/, "");
  if (/^0?(56|59)/.test(digits)) {
    const national = digits.replace(/^0/, "");
    unique.add(`0${national}`);
    unique.add(`970${national}`);
    unique.add(`972${national}`);
    unique.add(`+970${national}`);
    unique.add(`+972${national}`);
    unique.add(`00970${national}`);
    unique.add(`00972${national}`);
  }

  return Array.from(unique);
}
