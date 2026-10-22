import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authenticatedProcedure } from "./_core/trpc";
import { requireSupabaseSiteRole } from "./powerhub-supabase";
import { supabaseAdmin } from "./supabase-admin";

const maintenanceRoles = ["owner", "manager", "technician"] as const;
const readRoles = ["owner", "manager", "technician", "accountant", "viewer"] as const;
const operationKey = z.string().trim().min(8).max(180);
const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabaseAdmin().rpc(name, args);
  if (error) {
    const message = String(error.message ?? "");
    const code = [
      "MAINTENANCE_IDEMPOTENCY_KEY_REUSED", "MAINTENANCE_WORK_ORDER_NOT_FOUND",
      "MAINTENANCE_WORK_ORDER_NOT_OPEN", "MAINTENANCE_INVALID_STATE_TRANSITION",
      "MAINTENANCE_CLOSEOUT_SUMMARY_REQUIRED", "MAINTENANCE_CLOSEOUT_HOURS_REQUIRED",
      "MAINTENANCE_HOURS_BACKWARDS", "INSUFFICIENT_STOCK", "FINANCIAL_PERIOD_LOCKED",
      "MAINTENANCE_GENERATOR_OUT_OF_SCOPE", "MAINTENANCE_PART_ITEM_OUT_OF_SCOPE",
      "MAINTENANCE_PART_CATEGORY_INVALID", "MAINTENANCE_CANCEL_REASON_REQUIRED",
      "MAINTENANCE_PLAN_INTERVAL_REQUIRED", "MAINTENANCE_PLAN_DATE_DUE_REQUIRED",
      "MAINTENANCE_PLAN_HOURS_DUE_REQUIRED"
    ].find((candidate) => message.includes(candidate));
    if (code) throw new TRPCError({ code: "BAD_REQUEST", message: code });
    console.error("[PowerHub maintenance RPC]", { name, code: error.code });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تنفيذ عملية الصيانة. تحقق من البيانات والصلاحيات ثم أعد المحاولة." });
  }
  return data as T;
};

export const powerhubMaintenanceRouter = router({
  listWorkOrders: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(),
    generatorId: z.number().int().positive().optional(),
    status: z.enum(["scheduled", "new", "in_progress", "waiting_for_parts", "completed", "cancelled"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...readRoles], "manageMaintenance");
    return rpc("powerhub_maintenance_list_work_orders", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId,
      p_generator_id: input.generatorId ?? null, p_status: input.status ?? null, p_limit: input.limit,
    });
  }),
  listPreventivePlans: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(), generatorId: z.number().int().positive().optional(),
  })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...readRoles], "manageMaintenance");
    return rpc("powerhub_maintenance_list_preventive_plans", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_generator_id: input.generatorId ?? null,
    });
  }),
  listParts: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(), workOrderId: z.number().int().positive(),
  })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...readRoles], "manageMaintenance");
    return rpc("powerhub_maintenance_list_parts", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_work_order_id: input.workOrderId,
    });
  }),
  createWorkOrder: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(), generatorId: z.number().int().positive(),
    orderType: z.enum(["breakdown", "preventive", "inspection", "repair", "other"]),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    title: z.string().trim().min(3).max(180), description: z.string().max(5000).optional(),
    reportedAt: z.string().datetime().optional(), scheduledFor: z.string().datetime().optional(),
    assignedToUserId: z.number().int().positive().optional(), operationKey,
  })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...maintenanceRoles], "manageMaintenance");
    return rpc("powerhub_maintenance_create_work_order", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
      p_generator_id: input.generatorId, p_order_type: input.orderType, p_priority: input.priority,
      p_title: input.title, p_description: input.description ?? null,
      p_reported_at: input.reportedAt ?? null, p_scheduled_for: input.scheduledFor ?? null,
      p_assigned_to_user_id: input.assignedToUserId ?? null, p_operation_key: input.operationKey,
    });
  }),
  addPart: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(), workOrderId: z.number().int().positive(),
    itemId: z.number().int().positive(), warehouseId: z.number().int().positive(),
    quantity: z.number().positive().max(1000000), notes: z.string().max(1000).optional(), operationKey,
  })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...maintenanceRoles], "manageMaintenance");
    if (!access.permissions.includes("issueInventory")) throw new TRPCError({ code: "FORBIDDEN", message: "تحتاج إلى صلاحية صرف المخزون لاستخدام قطع الغيار." });
    return rpc("powerhub_maintenance_add_part", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
      p_work_order_id: input.workOrderId, p_item_id: input.itemId, p_warehouse_id: input.warehouseId,
      p_quantity: input.quantity, p_notes: input.notes ?? null, p_operation_key: input.operationKey,
    });
  }),
  transitionWorkOrder: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(), workOrderId: z.number().int().positive(),
    action: z.enum(["start", "wait_for_parts", "complete", "cancel"]),
    workSummary: z.string().max(5000).optional(), meterHoursClose: z.number().min(0).max(1000000000).optional(),
    downtimeMinutes: z.number().int().min(0).max(525600).optional(),
    laborCost: z.number().min(0).max(1000000000).default(0),
    externalServiceCost: z.number().min(0).max(1000000000).default(0),
    reason: z.string().max(500).optional(), operationKey,
  })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...maintenanceRoles], "manageMaintenance");
    if (input.action === "complete" && !access.permissions.includes("manageExpenses")) {
      throw new TRPCError({ code: "FORBIDDEN", message: "تحتاج إلى صلاحية إدارة المصروفات لاعتماد تكاليف الإغلاق." });
    }
    return rpc("powerhub_maintenance_transition_work_order", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
      p_work_order_id: input.workOrderId, p_action: input.action, p_work_summary: input.workSummary ?? null,
      p_meter_hours_close: input.meterHoursClose ?? null, p_downtime_minutes: input.downtimeMinutes ?? null,
      p_labor_cost: input.laborCost, p_external_service_cost: input.externalServiceCost,
      p_reason: input.reason ?? null, p_operation_key: input.operationKey,
    });
  }),
  createPreventivePlan: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(), generatorId: z.number().int().positive(),
    planCode: z.string().trim().min(2).max(40), title: z.string().trim().min(3).max(180),
    description: z.string().max(5000).optional(), intervalDays: z.number().int().min(1).max(3650).optional(),
    intervalOperatingHours: z.number().positive().max(1000000).optional(),
    nextDueAt: z.string().datetime().optional(), nextDueOperatingHours: z.number().min(0).max(1000000000).optional(),
    dueSoonDays: z.number().int().min(0).max(365).default(7), dueSoonHours: z.number().min(0).max(1000000).default(10),
    operationKey,
  })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...maintenanceRoles], "manageMaintenance");
    return rpc("powerhub_maintenance_create_preventive_plan", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
      p_generator_id: input.generatorId, p_plan_code: input.planCode, p_title: input.title,
      p_description: input.description ?? null, p_interval_days: input.intervalDays ?? null,
      p_interval_operating_hours: input.intervalOperatingHours ?? null, p_next_due_at: input.nextDueAt ?? null,
      p_next_due_operating_hours: input.nextDueOperatingHours ?? null, p_due_soon_days: input.dueSoonDays,
      p_due_soon_hours: input.dueSoonHours, p_operation_key: input.operationKey,
    });
  }),
});
