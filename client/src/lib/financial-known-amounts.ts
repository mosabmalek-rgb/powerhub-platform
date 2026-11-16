/**
 * A financial total is known only when every component has a valid monetary
 * value. Missing or malformed components must not become fabricated zeroes.
 * Use integer minor units so cents add without binary-float drift.
 */
export function sumKnownFinancialAmounts(...values: unknown[]): number | null {
  if (values.length === 0) return null;
  let cents = 0;
  for (const value of values) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" &&
        (!value.trim() || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()))) return null;
    const amount = Number(value);
    if (!Number.isFinite(amount)) return null;
    const inCents = amount * 100;
    const rounded = Math.round(inCents);
    if (!Number.isSafeInteger(rounded) || Math.abs(inCents - rounded) > 0.000001) return null;
    if (!Number.isSafeInteger(cents + rounded)) return null;
    cents += rounded;
  }
  return cents / 100;
}
