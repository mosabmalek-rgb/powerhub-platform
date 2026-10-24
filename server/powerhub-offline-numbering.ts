import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireSupabaseSiteRole } from "./powerhub-supabase";
import { supabaseAdmin } from "./supabase-admin";

const reserveInput = z.object({
  siteId: z.number().int().positive(),
  requestId: z.string().uuid(),
  numberKind: z.enum(["subscriber", "invoice"]),
  partitionKey: z.string().regex(/^(global|[0-9]{4})$/),
  count: z.number().int().min(1).max(200).default(50),
  ttlMinutes: z.number().int().min(1).max(43_200).default(43_200),
});

export const powerhubOfflineNumberingRouter = router({
  reserve: protectedProcedure.input(reserveInput).mutation(async ({ ctx, input }) => {
    const capability = input.numberKind === "subscriber" ? "manageSubscribers" : "issueInvoices";
    const allowedRoles = input.numberKind === "subscriber"
      ? ["owner", "manager", "accountant"] as const
      : ["owner", "manager", "accountant"] as const;
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...allowedRoles], capability);

    const rawDeviceId = ctx.req?.headers?.["x-powerhub-device-id"];
    const deviceId = Array.isArray(rawDeviceId) ? rawDeviceId[0] : rawDeviceId;
    if (typeof deviceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "تعذر التحقق من جهاز PowerHub الحالي." });
    }
    if (input.numberKind === "subscriber" && input.partitionKey !== "global") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أرقام المشتركين عالمية ولا تقبل تقسيمًا حسب السنة." });
    }
    if (input.numberKind === "invoice" && !/^[0-9]{4}$/.test(input.partitionKey)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "سنة تخصيص الفاتورة غير صالحة." });
    }

    const { data, error } = await supabaseAdmin().rpc("powerhub_reserve_offline_number_grant", {
      p_tenant_id: access.tenantId,
      p_site_id: input.siteId,
      p_user_id: ctx.user.id,
      p_device_id: deviceId,
      p_request_id: input.requestId,
      p_number_kind: input.numberKind,
      p_partition_key: input.partitionKey,
      p_count: input.count,
      p_ttl_minutes: input.ttlMinutes,
    });
    if (error) {
      const message = String(error.message ?? "");
      if (message.includes("SUBSCRIBER_REFERENCE_EXHAUSTED")) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "نفدت مساحة أرقام المشتركين المتاحة." });
      }
      if (message.includes("INVOICE_REFERENCE_EXHAUSTED")) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "نفدت مساحة أرقام الفواتير المتاحة ضمن الصيغة الرسمية." });
      }
      if (message.includes("SITE_OUT_OF_SCOPE") || message.includes("USER_OUT_OF_SCOPE")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "نطاق حجز الأرقام غير صالح." });
      }
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حجز نطاق أرقام آمن لهذا الجهاز." });
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.grant_id || !Array.isArray(row.reserved_values) || row.reserved_values.length < 1) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم يُرجع الخادم نطاق أرقام صالحًا." });
    }
    return {
      id: String(row.grant_id),
      userId: ctx.user.id,
      tenantId: access.tenantId,
      siteId: input.siteId,
      deviceId,
      numberKind: input.numberKind,
      partitionKey: String(row.partition_key),
      reservedValues: row.reserved_values.map((value: string | number) => String(value)),
      issuedAt: new Date(row.issued_at).getTime(),
      expiresAt: new Date(row.expires_at).getTime(),
    };
  }),
});
