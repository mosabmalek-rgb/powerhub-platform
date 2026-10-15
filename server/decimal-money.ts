/**
 * Exact decimal conversion helpers for amounts stored as PostgreSQL numeric(…, 2).
 * Use integer minor units for arithmetic to avoid IEEE-754 rounding errors.
 */
export function decimalAmountToMinorUnits(value: string | number | bigint | null | undefined): bigint {
  if (value == null) return 0n;

  const raw = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) {
    throw new Error("Invalid monetary amount; expected a decimal with at most two fractional digits.");
  }

  const wholeUnits = BigInt(match[2]);
  const fractionText = (match[3] ?? "").padEnd(2, "0");
  const fractionalUnits = BigInt(fractionText || "0");
  const amount = wholeUnits * 100n + fractionalUnits;
  return match[1] === "-" ? -amount : amount;
}

export function minorUnitsToAmountString(minorUnits: bigint): string {
  const negative = minorUnits < 0n;
  const absolute = negative ? -minorUnits : minorUnits;
  const wholeUnits = absolute / 100n;
  const fractionalUnits = (absolute % 100n).toString().padStart(2, "0");
  const formatted = fractionalUnits === "00"
    ? wholeUnits.toString()
    : `${wholeUnits}.${fractionalUnits.replace(/0+$/, "")}`;

  return negative && absolute !== 0n ? `-${formatted}` : formatted;
}


/**
 * Format monetary values for message templates with exactly one fractional digit.
 * Display rounding is performed with decimal strings/integers (not floating point).
 * This formatter must never be used for balance aggregation or persisted amounts.
 */
export function formatMessageAmount(value: string | number | bigint | null | undefined): string {
  if (value == null) return "";

  const raw = String(value).trim();
  const match = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return raw;

  const negative = match[1] === "-";
  let whole = BigInt(match[2].replace(/,/g, ""));
  let tenths = BigInt((match[3] ?? "0")[0] ?? "0");
  const secondFractionalDigit = (match[3] ?? "")[1] ?? "0";
  if (secondFractionalDigit >= "5") tenths += 1n;

  if (tenths >= 10n) {
    whole += 1n;
    tenths = 0n;
  }

  let wholeText = whole.toString();
  wholeText = wholeText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = negative && (whole !== 0n || tenths !== 0n) ? "-" : "";
  return `${sign}${wholeText}.${tenths.toString()}`;
}


/**
 * Policy-aware monetary display for messages only. With a settlement policy,
 * suppress the fractional portion without rounding a debt upward. Otherwise
 * retain the existing one-decimal display formatter. Never persist this output.
 */
export function formatPolicyAwareMessageAmount(
  value: string | number | bigint | null | undefined,
  settlementEnabled: boolean,
): string {
  if (value == null) return "";
  if (!settlementEnabled) return formatMessageAmount(value);

  const raw = String(value).trim();
  const match = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return raw;
  const whole = BigInt(match[2].replace(/,/g, ""));
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return match[1] === "-" && whole !== 0n ? `-${grouped}` : grouped;
}
