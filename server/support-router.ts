import { router, platformSupportProcedure } from "./_core/trpc";
import { z } from "zod";
import { supabaseAdmin } from "./supabase-admin";
import { TRPCError } from "@trpc/server";

const queueInput = z.object({
  status: z.string().trim().max(40).nullable().optional(),
  priority: z.string().trim().max(20).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  assignedUserId: z.number().int().positive().nullable().optional(),
  search: z.string().trim().max(200).nullable().optional(),
  limit: z.number().int().min(1).max(100).default(100),
  offset: z.number().int().min(0).default(0),
});

export const supportRouter = router({
  assertAccess: platformSupportProcedure.query(() => ({ allowed: true as const })),

  queueSnapshot: platformSupportProcedure.input(queueInput).query(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const pageSize = Math.min(input.limit, 100);
    const { data: conversations, error: conversationsError } = await admin
      .from("chat_conversations")
      .select("id,ticket_number,tenant_id,subject,status,priority,category_code,assigned_user_id,created_by_user_id,last_message_at,first_response_at,first_response_due_at,resolution_due_at,resolved_at,closed_at,auto_close_at,created_at")
      .eq("conversation_type", "support")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .range(input.offset, input.offset + pageSize - 1);

    if (conversationsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل محادثات الدعم." });

    const rows = conversations ?? [];
    const tenantIds = [...new Set(rows.map((row) => Number(row.tenant_id)).filter(Number.isFinite))];
    const userIds = [...new Set(
      rows.flatMap((row) => [Number(row.assigned_user_id), Number(row.created_by_user_id)]).filter(Number.isFinite),
    )];

    const [tenantsResult, usersResult, categoriesResult, assignmentsResult, supportUsersResult, tagsResult] = await Promise.all([
      tenantIds.length ? admin.from("tenants").select("id,name").in("id", tenantIds) : Promise.resolve({ data: [], error: null }),
      userIds.length ? admin.from("users").select("id,name,email,platform_role").in("id", userIds) : Promise.resolve({ data: [], error: null }),
      admin.from("chat_support_categories").select("code,name").eq("is_active", true).order("sort_order"),
      admin.from("chat_support_assignments").select("id,conversation_id,assigned_user_id,status"),
      admin.rpc("chat_support_users"),
      admin.from("chat_support_tags").select("id,name").eq("is_active", true).order("name"),
    ]);

    if (tenantsResult.error || usersResult.error || categoriesResult.error || assignmentsResult.error || supportUsersResult.error || tagsResult.error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات طابور الدعم." });
    }

    const tenants = new Map((tenantsResult.data ?? []).map((row: any) => [Number(row.id), row]));
    const users = new Map((usersResult.data ?? []).map((row: any) => [Number(row.id), row]));
    const categories = new Map((categoriesResult.data ?? []).map((row: any) => [String(row.code), row]));

    const messageRows = rows.length
      ? await admin.from("chat_messages")
        .select("conversation_id,sender_user_id,created_at")
        .in("conversation_id", rows.map((row) => Number(row.id)))
        .eq("visibility", "public")
      : { data: [], error: null };
    if (messageRows.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مؤشرات رسائل الدعم." });

    const participants = rows.length
      ? await admin.from("chat_participants").select("conversation_id,user_id,last_read_at,left_at").in("conversation_id", rows.map((row) => Number(row.id))).eq("user_id", ctx.user.id).is("left_at", null)
      : { data: [], error: null };
    if (participants.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حالة قراءة الدعم." });

    const lastReadByConversation = new Map<number, string | null>();
    for (const row of participants.data ?? []) lastReadByConversation.set(Number(row.conversation_id), row.last_read_at ?? null);

    const unreadCount = new Map<number, number>();
    for (const message of messageRows.data ?? []) {
      const conversationId = Number(message.conversation_id);
      const lastRead = lastReadByConversation.get(conversationId);
      if (Number(message.sender_user_id) !== ctx.user.id && (!lastRead || new Date(message.created_at) > new Date(lastRead))) {
        unreadCount.set(conversationId, (unreadCount.get(conversationId) ?? 0) + 1);
      }
    }

    let mapped = rows.map((row: any) => {
      const tenant = tenants.get(Number(row.tenant_id));
      const assigned = users.get(Number(row.assigned_user_id));
      const requester = users.get(Number(row.created_by_user_id));
      const category = categories.get(String(row.category_code));
      const sla =
        row.status === "CLOSED" ? "closed" :
        row.status === "RESOLVED" ? "resolved" :
        row.first_response_at == null && row.first_response_due_at && new Date() > new Date(row.first_response_due_at) ? "first_response_breached" :
        row.resolution_due_at && row.resolved_at == null && new Date() > new Date(row.resolution_due_at) ? "resolution_breached" :
        "on_track";
      return {
        ...row,
        conversation_id: Number(row.id),
        tenant_name: tenant?.name ?? null,
        category_name: category?.name ?? null,
        assigned_user_name: assigned?.name ?? null,
        requester_user_id: Number(row.created_by_user_id),
        requester_name: requester?.name ?? null,
        requester_email: requester?.email ?? null,
        unread_count: unreadCount.get(Number(row.id)) ?? 0,
        sla_state: sla,
      };
    });

    if (input.status) mapped = mapped.filter((row) => row.status === input.status);
    if (input.priority) mapped = mapped.filter((row) => row.priority === input.priority);
    if (input.category) mapped = mapped.filter((row) => row.category_code === input.category);
    if (input.assignedUserId) mapped = mapped.filter((row) => Number(row.assigned_user_id) === input.assignedUserId);
    if (input.search) {
      const q = input.search.toLowerCase();
      mapped = mapped.filter((row) =>
        String(row.ticket_number ?? "").toLowerCase().includes(q) ||
        String(row.subject ?? "").toLowerCase().includes(q) ||
        String(row.tenant_name ?? "").toLowerCase().includes(q) ||
        String(row.requester_name ?? "").toLowerCase().includes(q) ||
        String(row.requester_email ?? "").toLowerCase().includes(q),
      );
    }

    mapped.sort((a, b) => {
      const statusRank = (value: string) => ({ SUPPORT_PENDING: 0, SUPPORT_ACTIVE: 1, WAITING_USER: 2, RESOLVED: 3, CLOSED: 4 } as Record<string, number>)[value] ?? 5;
      const priorityRank = (value: string) => ({ urgent: 0, high: 1, normal: 2, low: 3 } as Record<string, number>)[value] ?? 4;
      return statusRank(a.status) - statusRank(b.status) || priorityRank(a.priority) - priorityRank(b.priority) || String(b.last_message_at ?? "").localeCompare(String(a.last_message_at ?? ""));
    });

    return {
      conversations: mapped,
      assignments: assignmentsResult.data ?? [],
      supportUsers: supportUsersResult.data ?? [],
      categories: categoriesResult.data ?? [],
      tags: tagsResult.data ?? [],
    };
  }),
});
