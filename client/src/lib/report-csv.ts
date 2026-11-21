/**
 * Quote a CSV cell and neutralize user-controlled strings that spreadsheet
 * applications may interpret as formulas. Numeric values remain numeric,
 * including negative amounts.
 */
export function escapeCsvCell(value: unknown): string {
  const raw = String(value ?? "");
  const formulaLikeText = typeof value === "string" && /^[\u0000-\u0020\uFEFF]*[=+\-@]/.test(raw);
  const safe = formulaLikeText ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
