export interface FreshOnlineServerReadState {
  online: boolean;
  data: unknown;
  fetchedAfterMount: boolean;
  fetching: boolean;
  error: boolean;
}

/**
 * Cached query data is not proof of a fresh server read. This guard is used
 * before exposing payroll details, exports, and payout controls.
 */
export function isFreshOnlineServerRead(state: FreshOnlineServerReadState): boolean {
  return state.online &&
    state.data !== undefined &&
    state.fetchedAfterMount &&
    !state.fetching &&
    !state.error;
}

/**
 * Resolve an account only from the list returned by the current server read.
 * The caller must perform/validate that read before using this helper.
 */
export function resolvePayrollPayoutAccountId(
  accounts: readonly { id: unknown }[] | null | undefined,
  selectedAccountId: string,
): number | null {
  const selectedId = Number(selectedAccountId);
  if (!Number.isSafeInteger(selectedId) || selectedId < 1 || !Array.isArray(accounts)) {
    return null;
  }

  const existsInFreshResult = accounts.some((account) => {
    const accountId = Number(account.id);
    return Number.isSafeInteger(accountId) && accountId === selectedId;
  });

  return existsInFreshResult ? selectedId : null;
}
