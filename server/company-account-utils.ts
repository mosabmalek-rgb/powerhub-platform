export type CompanyAccountMovement = {
  transactionType: string;
  amount: number | string;
};

const debitTransactionTypes = new Set(["withdrawal", "transfer_out"]);

export function calculateCompanyAccountBalance(
  openingBalance: number | string | null | undefined,
  movements: readonly CompanyAccountMovement[],
) {
  const parsedOpeningBalance = Number(openingBalance ?? 0);
  const safeOpeningBalance = Number.isFinite(parsedOpeningBalance) ? parsedOpeningBalance : 0;

  return movements.reduce((balance, movement) => {
    const parsedAmount = Number(movement.amount);
    if (!Number.isFinite(parsedAmount)) return balance;
    return balance + (debitTransactionTypes.has(movement.transactionType) ? -parsedAmount : parsedAmount);
  }, safeOpeningBalance);
}
