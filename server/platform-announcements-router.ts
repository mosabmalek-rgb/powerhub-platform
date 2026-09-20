import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";

const adminProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه العملية مخصصة لإدارة المنصة." });
  }
  return next();
});

const announcementType = z.enum(["news", "announcement", "maintenance", "alert"]);
const announcementStatus = z.enum(["draft", "published", "archived"]);

function mapAnnouncement(row: any, readAt?: string | null) {
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body,
    type: row.announcement_type,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: Number(row.created_by_user_id),
    readAt: readAt ?? null,
  };
}

export const platformAnnouncementsRouter = router({
  admin: router({
    list: adminProcedure.query(async () => {
      const { data, error } = await supabaseAdmin()
        .from("platform_announcements")
        .select("id,title,body,announcement_type,status,published_at,created_by_user_id,created_at,updated_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعلانات المنصة." });
      return (data ?? []).map((row) => mapAnnouncement(row));
    }),
    create: adminProcedure.input(z.object({
      title: z.string().trim().min(2).max(180),
      body: z.string().trim().min(2).max(10000),
      type: announcementType.default("news"),
      status: z.enum(["draft", "published"]).default("draft"),
    })).mutation(async ({ ctx, input }) => {
      const published = input.status === "published";
      const { data, error } = await supabaseAdmin()
        .from("platform_announcements")
        .insert({
          title: input.title,
          body: input.body,
          announcement_type: input.type,
          status: input.status,
          published_at: published ? new Date().toISOString() : null,
          created_by_user_id: ctx.user.id,
          updated_by_user_id: ctx.user.id,
        })
        .select("id,title,body,announcement_type,status,published_at,created_by_user_id,created_at,updated_at")
        .single();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء الإعلان." });
      return mapAnnouncement(data);
    }),
    update: adminProcedure.input(z.object({
      id: z.number().int().positive(),
      title: z.string().trim().min(2).max(180),
      body: z.string().trim().min(2).max(10000),
      type: announcementType,
    })).mutation(async ({ ctx, input }) => {
      const { data, error } = await supabaseAdmin()
        .from("platform_announcements")
        .update({ title: input.title, body: input.body, announcement_type: input.type, updated_by_user_id: ctx.user.id })
        .eq("id", input.id)
        .select("id,title,body,announcement_type,status,published_at,created_by_user_id,created_at,updated_at")
        .single();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تعديل الإعلان." });
      return mapAnnouncement(data);
    }),
    publish: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const { data, error } = await supabaseAdmin()
        .from("platform_announcements")
        .update({ status: "published", published_at: new Date().toISOString(), updated_by_user_id: ctx.user.id })
        .eq("id", input.id)
        .neq("status", "archived")
        .select("id,title,body,announcement_type,status,published_at,created_by_user_id,created_at,updated_at")
        .single();
      if (error) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر نشر الإعلان؛ قد يكون مؤرشفًا أو غير موجود." });
      return mapAnnouncement(data);
    }),
    archive: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const { data, error } = await supabaseAdmin()
        .from("platform_announcements")
        .update({ status: "archived", updated_by_user_id: ctx.user.id })
        .eq("id", input.id)
        .select("id,title,body,announcement_type,status,published_at,created_by_user_id,created_at,updated_at")
        .single();
      if (error) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر أرشفة الإعلان." });
      return mapAnnouncement(data);
    }),
  }),
  inbox: router({
    list: authenticatedProcedure.query(async ({ ctx }) => {
      const { data, error } = await supabaseAdmin()
        .from("platform_announcements")
        .select("id,title,body,announcement_type,status,published_at,created_by_user_id,created_at,updated_at")
        .eq("status", "published")
        .not("published_at", "is", null)
        .lte("published_at", new Date().toISOString())
        .order("published_at", { ascending: false })
        .limit(100);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الإشعارات الداخلية." });
      const ids = (data ?? []).map((row) => Number(row.id));
      const reads = ids.length
        ? await supabaseAdmin().from("platform_announcement_reads").select("announcement_id,read_at").eq("user_id", ctx.user.id).in("announcement_id", ids)
        : { data: [], error: null };
      if (reads.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حالة القراءة." });
      const readMap = new Map((reads.data ?? []).map((row) => [Number(row.announcement_id), row.read_at]));
      return (data ?? []).map((row) => mapAnnouncement(row, readMap.get(Number(row.id)) ?? null));
    }),
    markRead: authenticatedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const { data: announcement, error: announcementError } = await supabaseAdmin()
        .from("platform_announcements")
        .select("id,status,published_at")
        .eq("id", input.id)
        .eq("status", "published")
        .single();
      if (announcementError || !announcement) throw new TRPCError({ code: "NOT_FOUND", message: "الإعلان غير موجود." });
      const { error } = await supabaseAdmin().from("platform_announcement_reads").upsert(
        { announcement_id: input.id, user_id: ctx.user.id, read_at: new Date().toISOString() },
        { onConflict: "announcement_id,user_id" },
      );
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل قراءة الإعلان." });
      return { success: true as const };
    }),
  }),
});
