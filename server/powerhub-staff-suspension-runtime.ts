import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireSupabaseSiteRole, writeSupabaseAuditBestEffort } from "./powerhub-supabase";
import { supabaseAdmin } from "./supabase-admin";

const suspendInput = z.object({
  siteId: z.number().int().positive(),
  profileId: z.number().int().positive(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

const clearSuspensionInput = z.object({
  siteId: z.number().int().positive(),
  profileId: z.number().int().positive(),
});

export const powerhubStaffSuspensionRuntimeRouter = router({
  suspend: protectedProcedure.input(suspendInput).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (endsAt <= startsAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "يجب أن يكون تاريخ نهاية التوقيف بعد تاريخ البداية." });
    }

    const admin = supabaseAdmin();
    const { data: profile, error: profileError } = await admin
      .from("staff_profiles")
      .select("id, user_id, site_id")
      .eq("id", input.profileId)
      .eq("tenant_id", access.tenantId)
      .eq("is_active", true)
      .or(`site_id.eq.${input.siteId},site_id.is.null`)
      .maybeSingle();

    if (profileError) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الحساب الفرعي من Supabase." });
    }
    if (!profile) {
      throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
    }

    const { error: updateError } = await admin
      .from("staff_profiles")
      .update({
        suspension_started_at: startsAt.toISOString(),
        suspension_ends_at: endsAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.profileId)
      .eq("tenant_id", access.tenantId);

    if (updateError) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث فترة التوقيف في Supabase." });
    }

    await writeSupabaseAuditBestEffort({
      userId: ctx.user.id,
      tenantId: access.tenantId,
      siteId: input.siteId,
      entityType: "staff_profile",
      entityId: String(input.profileId),
      action: "suspend_until",
      afterData: {
        targetUserId: Number(profile.user_id),
        suspensionStartedAt: startsAt.toISOString(),
        suspensionEndsAt: endsAt.toISOString(),
      },
    });

    return { success: true, suspensionEndsAt: endsAt };
  }),

  clearSuspension: protectedProcedure.input(clearSuspensionInput).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
    const admin = supabaseAdmin();
    const { data: profile, error: profileError } = await admin
      .from("staff_profiles")
      .select("id, user_id")
      .eq("id", input.profileId)
      .eq("tenant_id", access.tenantId)
      .eq("is_active", true)
      .or(`site_id.eq.${input.siteId},site_id.is.null`)
      .maybeSingle();

    if (profileError) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الحساب الفرعي من Supabase." });
    }
    if (!profile) {
      throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
    }

    const { error: updateError } = await admin
      .from("staff_profiles")
      .update({
        suspension_started_at: null,
        suspension_ends_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.profileId)
      .eq("tenant_id", access.tenantId);

    if (updateError) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إلغاء التوقيف في Supabase." });
    }

    await writeSupabaseAudit({
      userId: ctx.user.id,
      tenantId: access.tenantId,
      siteId: input.siteId,
      entityType: "staff_profile",
      entityId: String(input.profileId),
      action: "clear_suspension",
      afterData: { targetUserId: Number(profile.user_id) },
    });

    return { success: true };
  }),
});
