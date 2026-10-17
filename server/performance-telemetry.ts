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
