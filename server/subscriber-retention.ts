import { supabaseAdmin } from "./supabase-admin";

export async function processSubscriberRetention(batchSize = 50) {
  const admin = supabaseAdmin();
  const { data: claimed, error } = await admin.rpc("powerhub_claim_expired_subscribers", { p_limit: Math.min(Math.max(Math.trunc(batchSize), 1), 100) });
  if (error) throw new Error(`تعذر حجز المشتركين المنتهية مدة احتفاظهم: ${error.message}`);
  let purged = 0, failed = 0;
  const failures: Array<{ subscriberId: number; message: string }> = [];
  for (const row of claimed ?? []) {
    const subscriberId = Number(row.subscriber_id);
    try {
      const { data, error: purgeError } = await admin.rpc("powerhub_finalize_expired_subscriber_purge", { p_subscriber_id: subscriberId });
      if (purgeError) throw purgeError;
      if (data === true || data?.[0] === true) purged += 1;
      else await admin.rpc("powerhub_reset_subscriber_purge_claim", { p_subscriber_id: subscriberId });
    } catch (error) {
      failed += 1;
      try { await admin.rpc("powerhub_reset_subscriber_purge_claim", { p_subscriber_id: subscriberId }); } catch { /* keep original purge failure */ }
      failures.push({ subscriberId, message: error instanceof Error ? error.message : "تعذر حذف بيانات المشترك نهائياً." });
    }
  }
  return { claimed: (claimed ?? []).length, purged, failed, failures };
}
