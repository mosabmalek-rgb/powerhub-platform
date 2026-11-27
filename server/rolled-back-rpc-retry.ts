/**
 * Bounded whole-RPC retries only after PostgreSQL reports a transaction rollback.
 * Callers must opt in explicitly and keep the full request, including the operation
 * key, unchanged. Never retry transport failures, timeouts, ambiguous outcomes,
 * business errors, or thrown exceptions here.
 */
export async function retryRolledBackRpc<T extends { error: { code?: string } | null }>(
  operationKey: unknown,
  invoke: () => PromiseLike<T>,
): Promise<T> {
  const validKey = typeof operationKey === "string" &&
    operationKey.trim().length > 0 && operationKey.trim().length <= 150;
  // At most three complete attempts. Small jitter reduces synchronized retries.
  const delays = [25, 75];
  for (let attempt = 0; ; attempt++) {
    const result = await invoke();
    const code = result.error?.code;
    if (!validKey || (code !== "40P01" && code !== "40001") || attempt >= delays.length) {
      return result;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, delays[attempt]! + Math.floor(Math.random() * 26)));
  }
}
