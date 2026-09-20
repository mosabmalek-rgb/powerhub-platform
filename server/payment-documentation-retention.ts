import { supabaseAdmin } from "./supabase-admin";
import { storageRemove } from "./storage";

const DEFAULT_CLEANUP_BATCH_SIZE = 100;

type RetentionCandidate = {
  id: number;
  payment_id: number | null;
  receipt_image_key: string;
  status: "rejected" | "approved";
};

async function clearReceiptReferences(candidate: RetentionCandidate, deletedAt: string) {
  const admin = supabaseAdmin();
  const [requestResult, paymentsResult] = await Promise.all([
    admin.from("payment_documentation_requests")
      .update({
        receipt_image_key: null,
        receipt_image_deleted_at: deletedAt,
        updated_at: deletedAt,
      })
      .eq("id", candidate.id)
      .eq("receipt_image_key", candidate.receipt_image_key),
    admin.from("payments")
      .update({
        receipt_image_key: null,
      })
      .eq("receipt_image_key", candidate.receipt_image_key),
  ]);

  if (requestResult.error) throw new Error(`تعذر تنظيف مرجع صورة طلب توثيق الدفع: ${requestResult.error.message}`);
  if (paymentsResult.error) throw new Error(`تعذر تنظيف مرجع صورة الدفعة المعتمدة: ${paymentsResult.error.message}`);
}

export async function removePaymentDocumentationReceiptNow(input: {
  tenantId: number;
  siteId: number;
  requestId: number;
}): Promise<{ found: boolean; deleted: boolean }> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.from("payment_documentation_requests")
    .select("id, payment_id, receipt_image_key, status")
    .eq("id", input.requestId)
    .eq("tenant_id", input.tenantId)
    .eq("site_id", input.siteId)
    .maybeSingle();

  if (error) throw new Error(`تعذر قراءة صورة طلب توثيق الدفع: ${error.message}`);
  if (!data?.receipt_image_key || data.status !== "rejected") {
    return { found: Boolean(data), deleted: false };
  }

  const candidate: RetentionCandidate = {
    id: Number(data.id),
    payment_id: data.payment_id === null ? null : Number(data.payment_id),
    receipt_image_key: data.receipt_image_key,
    status: "rejected",
  };

  await storageRemove(candidate.receipt_image_key);
  const deletedAt = new Date().toISOString();
  await clearReceiptReferences(candidate, deletedAt);
  return { found: true, deleted: true };
}

export async function cleanupPaymentDocumentationReceiptImages(batchSize = DEFAULT_CLEANUP_BATCH_SIZE) {
  const limit = Math.min(Math.max(Math.trunc(batchSize), 1), DEFAULT_CLEANUP_BATCH_SIZE);
  const now = new Date().toISOString();
  const admin = supabaseAdmin();

  const [rejectedResult, approvedResult] = await Promise.all([
    admin.from("payment_documentation_requests")
      .select("id, payment_id, receipt_image_key, status")
      .eq("status", "rejected")
      .not("receipt_image_key", "is", null)
      .order("updated_at", { ascending: true })
      .limit(limit),
    admin.from("payment_documentation_requests")
      .select("id, payment_id, receipt_image_key, status")
      .eq("status", "approved")
      .not("receipt_image_key", "is", null)
      .not("receipt_image_retention_until", "is", null)
      .lte("receipt_image_retention_until", now)
      .order("receipt_image_retention_until", { ascending: true })
      .limit(limit),
  ]);

  if (rejectedResult.error) throw new Error(`تعذر تحميل صور التوثيق المرفوضة للتنظيف: ${rejectedResult.error.message}`);
  if (approvedResult.error) throw new Error(`تعذر تحميل صور التوثيق المنتهية للتنظيف: ${approvedResult.error.message}`);

  const seen = new Set<string>();
  const candidates: RetentionCandidate[] = [...(rejectedResult.data ?? []), ...(approvedResult.data ?? [])]
    .map((row) => ({
      id: Number(row.id),
      payment_id: row.payment_id === null ? null : Number(row.payment_id),
      receipt_image_key: String(row.receipt_image_key),
      status: row.status as "rejected" | "approved",
    }))
    .filter((candidate) => candidate.receipt_image_key && !seen.has(candidate.receipt_image_key) && seen.add(candidate.receipt_image_key));

  let deleted = 0;
  let failed = 0;
  const failures: Array<{ requestId: number; message: string }> = [];

  for (const candidate of candidates) {
    try {
      await storageRemove(candidate.receipt_image_key);
      await clearReceiptReferences(candidate, new Date().toISOString());
      deleted += 1;
    } catch (error) {
      failed += 1;
      failures.push({
        requestId: candidate.id,
        message: error instanceof Error ? error.message : "تعذر حذف صورة التوثيق.",
      });
    }
  }

  return {
    scanned: candidates.length,
    deleted,
    failed,
    failures,
  };
}
