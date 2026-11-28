import { supabaseAdmin } from "./supabase-admin";

export async function recordTenantSearchMetric(tenantId: number, resultCount: number): Promise<void> {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0
      || !Number.isInteger(resultCount) || resultCount < 0 || resultCount > 25) {
    return;
  }

  try {
    const { error } = await supabaseAdmin().rpc("powerhub_record_tenant_search_metric", {
      p_tenant_id: tenantId,
      p_result_count: resultCount,
    });
    if (error) {
      // Keep logs privacy-safe: do not include a query, row, tenant label, or error message.
      console.warn("[PowerHub subscriber search] Aggregate tenant telemetry recording failed.", {
        code: error.code ?? "UNKNOWN",
      });
    }
  } catch {
    // This telemetry is best-effort and must never make a successful directory search fail.
    console.warn("[PowerHub subscriber search] Aggregate tenant telemetry request failed.");
  }
}
