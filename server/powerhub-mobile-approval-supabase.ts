import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export type SupabaseMobileApprovalResult = {
  invoiceId: number;
  invoiceNo: string;
  totalAmount: number;
  notificationIds: number[];
  alreadyProcessed: boolean;
};

export async function approveAndIssueMobileReadingSupabase(input: {
  tenantId: number;
  siteId: number;
  userId: number;
  readingId: number;
  baseVersion: number;
  dueDate: Date;
  billingPeriod: string;
  discountAmount?: number;
}): Promise<SupabaseMobileApprovalResult> {
  const { data, error } = await supabaseAdmin().rpc("powerhub_approve_and_issue_mobile_reading", {
    p_tenant_id: input.tenantId,
    p_site_id: input.siteId,
    p_user_id: input.userId,
    p_reading_id: input.readingId,
    p_base_version: input.baseVersion,
    p_due_date: input.dueDate.toISOString(),
    p_billing_period: input.billingPeriod,
    p_discount_amount: input.discountAmount ?? 0,
  });

  if (error) {
    const message = error.message ?? "";
    if (message.includes("READING_OUT_OF_SCOPE") || message.includes("SITE_OUT_OF_SCOPE")) {
      throw new TRPCError({ code: "NOT_FOUND", message: "القراءة الميدانية غير موجودة ضمن الفرع المحدد." });
    }
    if (message.includes("READING_NOT_PENDING")) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يمكن اعتماد القراءات الميدانية بانتظار المراجعة فقط." });
    }
    if (message.includes("READING_VERSION_CONFLICT")) {
      throw new TRPCError({ code: "CONFLICT", message: "تم تعديل القراءة من جهة أخرى؛ حدّث البيانات ثم أعد المحاولة." });
    }
    if (message.includes("FINANCIAL_PERIOD_LOCKED")) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن إصدار الفاتورة داخلها." });
    }
    if (message.includes("TARIFF_NOT_FOUND")) {
      throw new TRPCError({ code: "NOT_FOUND", message: "لا توجد تعرفة فعالة يمكن استخدامها لإصدار الفاتورة." });
    }
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اعتماد القراءة وإصدار الفاتورة في Supabase." });
  }

  const row = (data as Array<{
    invoice_id: number | string;
    invoice_no: string;
    total_amount: number | string;
    notification_ids: Array<number | string> | null;
    already_processed: boolean;
  }> | null)?.[0];

  if (
    row?.invoice_id === undefined ||
    typeof row.invoice_no !== "string" ||
    row.total_amount === undefined ||
    !Array.isArray(row.notification_ids) ||
    typeof row.already_processed !== "boolean"
  ) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة اعتماد القراءة نتيجة صالحة." });
  }
  const notificationIds = row.notification_ids.map(Number);
  if (notificationIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "أعادت دالة اعتماد القراءة معرفات إشعارات غير صالحة." });
  }

  return {
    invoiceId: Number(row.invoice_id),
    invoiceNo: row.invoice_no,
    totalAmount: Number(row.total_amount),
    notificationIds,
    alreadyProcessed: row.already_processed,
  };
}
