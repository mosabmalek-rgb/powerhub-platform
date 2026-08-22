export type PayrollDetailSource = { period: string; employee: string; jobTitle: string; base: number; extra: number; advance: number; other: number; net: number };
export function buildPayrollDetailRow(period: string, row: { employee: { fullName: string; jobTitle: string }; item: { baseAmount: string | number; extraAmount: string | number; advanceDeduction: string | number; otherDeduction: string | number; netAmount: string | number } }): PayrollDetailSource {
  return { period, employee: row.employee.fullName, jobTitle: row.employee.jobTitle, base: Number(row.item.baseAmount), extra: Number(row.item.extraAmount), advance: Number(row.item.advanceDeduction), other: Number(row.item.otherDeduction), net: Number(row.item.netAmount) };
}
