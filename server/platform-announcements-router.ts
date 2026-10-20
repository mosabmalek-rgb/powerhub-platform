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
const announcementStatus = z.enum(["draft", "scheduled", "published", "archived"]);
const audienceRole = z.enum(["all", "owner", "manager", "accountant", "collector", "technician", "viewer", "platform_owner", "platform_admin", "finance_admin"]);
const audienceSchema = z.array(audienceRole).min(1).max(10).refine((roles) => roles.includes("all") ? roles.length === 1 : true, "all cannot be combined with specific roles");

function mapAnnouncement(row: any, readAt?: string | null) {
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body,
    type: row.announcement_type,
    status: row.status,
    publishedAt: row.published_at,
    scheduledAt: row.scheduled_at,
    tenantId: row.tenant_id ? Number(row.tenant_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: Number(row.created_by_user_id),
    readAt: readAt ?? null,
    audienceRoles: row.audience_roles ?? ["all"],
  };
}

export const platformAnnouncementsRouter = router({
  admin: router({
    list: adminProcedure.query(async () => {
      const { data, error } = await supabaseAdmin()
        .from("platform_announcements")
        .select("id,title,body,announcement_type,status,published_at,scheduled_at,audience_roles,created_by_user_id,created_at,updated_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعلانات المنصة." });
      return (data ?? []).map((row) => mapAnnouncement(row));
    }),
    create: adminProcedure.input(z.object({
      title: z.string().trim().min(2).max(180),
      body: z.string().trim().min(2).max(10000),
      type: announcementType.default("news"),
      audienceRoles: audienceSchema.default(["all"]),
      status: z.enum(["draft", "scheduled"]).default("draft"),
      scheduledAt: z.string().datetime().optional(),
    })).mutation(async ({ ctx, input }) => {
      const published = false;
      const scheduled = input.status === "scheduled";
      if (scheduled && (!input.scheduledAt || new Date(input.scheduledAt).getTime() <= Date.now())) throw new TRPCError({ code: "BAD_REQUEST", message: "وقت الجدولة يجب أن يكون في المستقبل." });
      const { data, error } = await supabaseAdmin()
        .from("platform_announcements")
        .insert({
          title: input.title,
          body: input.body,
          announcement_type: input.type,
          audience_roles: input.audienceRoles,
          status: input.status,
          published_at: published ? new Date().toISOString() : null,
          scheduled_at: scheduled ? input.scheduledAt : null,
          created_by_user_id: ctx.user.id,
          updated_by_user_id: ctx.user.id,
        })
        .select("id,title,body,announcement_type,status,published_at,scheduled_at,created_by_user_id,created_at,updated_at")
        .single();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء الإعلان." });
      return mapAnnouncement(data);
    }),
    update: adminProcedure.input(z.object({
      id: z.number().int().positive(),
      title: z.string().trim().min(2).max(180),
      body: z.string().trim().min(2).max(10000),
      type: announcementType,
      audienceRoles: audienceSchema,
      status: z.enum(["draft", "scheduled", "published"]),
      scheduledAt: z.string().datetime().nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      const { data, error } = await supabaseAdmin()
        .from("platform_announcements")
        .update({ title: input.title, body: input.body, announcement_type: input.type, audience_roles: input.audienceRoles, status: input.status, scheduled_at: input.status === "scheduled" ? input.scheduledAt : null, published_at: input.status === "published" ? new Date().toISOString() : null, updated_by_user_id: ctx.user.id })
        .eq("id", input.id)
        .select("id,title,body,announcement_type,status,published_at,created_by_user_id,created_at,updated_at")
        .single();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تعديل الإعلان." });
      return mapAnnouncement(data);
    }),
    publish: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const { data, error } = await supabaseAdmin()
        .from("platform_announcements")
        .update({ status: "published", published_at: new Date().toISOString(), scheduled_at: null, updated_by_user_id: ctx.user.id })
        .eq("id", input.id)
        .in("status", ["draft", "scheduled"])
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
      const { data: profiles } = await supabaseAdmin().from("staff_profiles").select("role").eq("user_id", ctx.user.id).eq("is_active", true);
      const { data: account } = await supabaseAdmin().from("users").select("role,platform_role,account_status").eq("id", ctx.user.id).single();
      if (!account || account.account_status !== "active") return [];
      const roles = new Set<string>(profiles?.map((p) => p.role) ?? []);
      const admin = supabaseAdmin();
      const { data: memberships } = await admin.from("tenant_members").select("tenant_id").eq("user_id", ctx.user.id).eq("is_active", true).eq("membership_status", "active");
      const tenantIds = new Set((memberships ?? []).map((row) => Number(row.tenant_id)));
      if (account.platform_role) roles.add(account.platform_role);
      const baseSelect = "id,title,body,announcement_type,status,published_at,scheduled_at,created_by_user_id,created_at,updated_at,audience_roles,tenant_id";
      const effectiveRoles = Array.from(new Set(["all", ...roles]));
      let visibleQuery = admin
        .from("platform_announcements")
        .select(baseSelect)
        .eq("status", "published")
        .not("published_at", "is", null)
        .lte("published_at", new Date().toISOString())
        .overlaps("audience_roles", effectiveRoles)
        .order("published_at", { ascending: false })
        .limit(100);
      if (tenantIds.size) {
        visibleQuery = visibleQuery.or(`tenant_id.is.null,tenant_id.in.(${Array.from(tenantIds).join(",")})`);
      } else {
        visibleQuery = visibleQuery.is("tenant_id", null);
      }
      const { data: visibleRows, error: visibleError } = await visibleQuery;
      if (visibleError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الإشعارات الداخلية." });
      const visible = visibleRows ?? [];
      const ids = visible.map((row) => Number(row.id));
      const reads = ids.length
        ? await supabaseAdmin().from("platform_announcement_reads").select("announcement_id,read_at").eq("user_id", ctx.user.id).in("announcement_id", ids)
        : { data: [], error: null };
      if (reads.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حالة القراءة." });
      const readMap = new Map((reads.data ?? []).map((row) => [Number(row.announcement_id), row.read_at]));
      return visible.map((row) => mapAnnouncement(row, readMap.get(Number(row.id)) ?? null));
    }),
    unreadCount: authenticatedProcedure.query(async ({ ctx }) => {
      const { data, error } = await supabaseAdmin().rpc("powerhub_platform_announcement_unread_count_for_user", {
        p_user_id: ctx.user.id,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حساب الإعلانات غير المقروءة." });
      return Math.max(0, Number(data ?? 0));
    }),
    markRead: authenticatedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const admin = supabaseAdmin();
      const [{ data: announcement, error: announcementError }, { data: profiles }, { data: account }] = await Promise.all([
        admin.from("platform_announcements")
          .select("id,status,published_at,audience_roles,tenant_id")
          .eq("id", input.id)
          .eq("status", "published")
          .not("published_at", "is", null)
          .lte("published_at", new Date().toISOString())
          .single(),
        admin.from("staff_profiles").select("role").eq("user_id", ctx.user.id).eq("is_active", true),
        admin.from("users").select("platform_role,account_status").eq("id", ctx.user.id).single(),
      ]);
      if (announcementError || !announcement || !account || account.account_status !== "active") {
        throw new TRPCError({ code: "NOT_FOUND", message: "الإعلان غير موجود." });
      }
      const roles = new Set<string>(profiles?.map((p) => p.role) ?? []);
      if (account.platform_role) roles.add(account.platform_role);
      const { data: memberships } = await admin.from("tenant_members").select("tenant_id").eq("user_id", ctx.user.id).eq("is_active", true).eq("membership_status", "active");
      const tenantIds = new Set((memberships ?? []).map((row) => Number(row.tenant_id)));
      const visible = (announcement.tenant_id == null || tenantIds.has(Number(announcement.tenant_id))) && (announcement.audience_roles?.includes("all") || announcement.audience_roles?.some((role: string) => roles.has(role)));
      if (!visible) throw new TRPCError({ code: "NOT_FOUND", message: "الإعلان غير موجود." });
      const { error } = await admin.from("platform_announcement_reads").upsert(
        { announcement_id: input.id, user_id: ctx.user.id, read_at: new Date().toISOString() },
        { onConflict: "announcement_id,user_id" },
      );
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل قراءة الإعلان." });
      return { success: true as const };
    }),
    markManyRead: authenticatedProcedure.input(z.object({ ids: z.array(z.number().int().positive()).max(100) })).mutation(async ({ ctx, input }) => {
      const ids = Array.from(new Set(input.ids));
      if (!ids.length) return { success: true as const, updated: 0 };
      const admin = supabaseAdmin();
      const now = new Date().toISOString();
      const [{ data: announcements, error: announcementsError }, { data: profiles }, { data: account }, { data: memberships }] = await Promise.all([
        admin.from("platform_announcements")
          .select("id,status,published_at,audience_roles,tenant_id")
          .in("id", ids).eq("status", "published")
          .not("published_at", "is", null).lte("published_at", now),
        admin.from("staff_profiles").select("role").eq("user_id", ctx.user.id).eq("is_active", true),
        admin.from("users").select("platform_role,account_status").eq("id", ctx.user.id).single(),
        admin.from("tenant_members").select("tenant_id").eq("user_id", ctx.user.id).eq("is_active", true).eq("membership_status", "active"),
      ]);
      if (announcementsError || !account || account.account_status !== "active") {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من الإعلانات المتاحة." });
      }
      const roles = new Set<string>(profiles?.map((profile) => profile.role) ?? []);
      if (account.platform_role) roles.add(account.platform_role);
      const tenantIds = new Set((memberships ?? []).map((row) => Number(row.tenant_id)));
      const visibleIds = (announcements ?? []).filter((announcement) =>
        (announcement.tenant_id == null || tenantIds.has(Number(announcement.tenant_id))) &&
        (announcement.audience_roles?.includes("all") || announcement.audience_roles?.some((role: string) => roles.has(role))),
      ).map((announcement) => Number(announcement.id));
      if (!visibleIds.length) return { success: true as const, updated: 0 };
      const { error } = await admin.from("platform_announcement_reads").upsert(
        visibleIds.map((announcement_id) => ({ announcement_id, user_id: ctx.user.id, read_at: now })),
        { onConflict: "announcement_id,user_id" },
      );
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث حالات قراءة الإعلانات." });
      return { success: true as const, updated: visibleIds.length };
    }),
  }),
});
