const previewValues: Record<string, string> = {
  subscriber_name: "أحمد علي", subscriber_no: "SUB-00125", invoice_no: "INV-2026-00125",
  billing_period: "آب 2026", total_amount: "33,000.825", balance_due: "18,000.456", due_date: "31 آب 2026",
  previous_reading: "12,450", current_reading: "12,785", consumption_kwh: "335", total_balance: "42,500.678",
  invoice_link: "https://powerhub.example/invoice/INV-2026-00125", portal_link: "https://powerhub.example/portal?g=MAIN",
};

const previewMoneyKeys = new Set(["total_amount", "balance_due", "total_balance"]);

function groupWholeAmount(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Preview-only money formatting: mirror the runtime's one-decimal policy without floating-point conversion. */
export function formatPreviewAmount(value: string, settlementEnabled: boolean): string {
  const raw = value.trim();
  const match = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return value;

  const negative = match[1] === "-";
  let whole = BigInt(match[2].replace(/,/g, ""));
  if (settlementEnabled) {
    const grouped = groupWholeAmount(whole);
    return negative && whole !== 0n ? `-${grouped}` : grouped;
  }

  const fraction = match[3] ?? "";
  let tenths = BigInt(fraction[0] ?? "0");
  if ((fraction[1] ?? "0") >= "5") tenths += 1n;
  if (tenths >= 10n) {
    whole += 1n;
    tenths = 0n;
  }

  const grouped = groupWholeAmount(whole);
  const sign = negative && (whole !== 0n || tenths !== 0n) ? "-" : "";
  return `${sign}${grouped}.${tenths.toString()}`;
}

export function previewMessageTemplate(body: string, settlementEnabled: boolean): string {
  return body.replace(/{{\s*(subscriber_name|subscriber_no|invoice_no|billing_period|total_amount|balance_due|previous_reading|current_reading|consumption_kwh|total_balance|due_date|invoice_link|portal_link)\s*}}/g, (_match, key: string) => {
    const value = previewValues[key] ?? "";
    return previewMoneyKeys.has(key) ? formatPreviewAmount(value, settlementEnabled) : value;
  });
}
