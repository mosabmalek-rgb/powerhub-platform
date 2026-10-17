/**
 * Privacy-safe stage timing for known latency-sensitive PowerHub operations.
 * Logs only slow stage names and durations; never logs request data, tokens, or IDs.
 */
export async function measureSlowStage<T>(
  operation: string,
  stage: string,
  work: () => Promise<T>,
  thresholdMs = 250,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    if (durationMs >= thresholdMs) {
      console.warn("[PowerHub stage latency]", {
        operation,
        stage,
        durationMs,
        vercelRegion: process.env.VERCEL_REGION ?? "local",
      });
    }
  }
}

/**
 * Bound a network-dependent stage so a stalled upstream cannot leave a public
 * page loading forever. When supported, the provided AbortSignal cancels the
 * underlying HTTP request as well as ending the caller's wait.
 */
export async function withTimeout<T>(
  operation: string,
  stage: string,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error(`${operation} timed out at ${stage}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work(controller.signal), timeout]);
  } catch (error) {
    if (!controller.signal.aborted) controller.abort();
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
