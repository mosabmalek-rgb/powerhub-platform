import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authenticatedProcedure } from "./_core/trpc";
import { requireSupabaseSiteRole } from "./powerhub-supabase";
import { supabaseAdmin } from "./supabase-admin";

const maintenanceRoles = ["owner", "manager", "technician"] as const;
const readRoles = ["owner", "manager", "technician", "accountant", "viewer"] as const;
async function requireMaintenanceReadAccess(userId: number, siteId: number) {
  try {
    return await requireSupabaseSiteRole(userId, siteId, [...readRoles], "viewInventory");
  } catch (error) {
    // A custom permission set may grant maintenance management without the general inventory-view capability.
    // Preserve normal platform-policy checks and allow the explicit maintenance capability as the alternate read grant.
    if (!(error instanceof TRPCError) || error.code !== "FORBIDDEN") throw error;
    return requireSupabaseSiteRole(userId, siteId, [...maintenanceRoles], "manageMaintenance");
  }
}

const operationKey = z.string().trim().min(8).max(180);
const isDateOnly = (value: string) => {
  if (value.length !== 10 || value[4] !== "-" || value[7] !== "-") return false;
  const digits = value.slice(0, 4) + value.slice(5, 7) + value.slice(8, 10);
  if ([...digits].some((character) => character < "0" || character > "9")) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
type MaintenancePreventivePlanListRow = {
  plan_id: number;
  plan_code: string;
  generator_id: number;
  generator_name: string;
  title: string;
  description: string | null;
  interval_days: number | null;
  interval_operating_hours: number | null;
  next_due_at: string | null;
  next_due_operating_hours: number | null;
  due_soon_days: number;
  due_soon_hours: number;
  is_active: boolean;
  last_completed_at: string | null;
  last_completed_operating_hours: number | null;
  alert_type: "due_soon" | "overdue" | "resolved" | null;
  observed_operating_hours: number | null;
};
type MaintenanceReportRow = {
  generator_id: number;
  generator_name: string;
  fault_title: string;
  work_order_count: number;
  breakdown_count: number;
  preventive_count: number;
  completed_count: number;
  open_count: number;
  downtime_minutes: number;
  parts_cost: number;
  labor_cost: number;
  external_service_cost: number;
  total_cost_amount: number;
  first_reported_at: string;
  last_reported_at: string;
};
type MaintenanceAssignableSupplierRow = { id: number; supplier_code: string | null; name: string };
type MaintenancePartListRow = {
  part_id: number;
  item_id: number;
  item_name: string;
  category: string;
  warehouse_id: number;
  warehouse_name: string;
  quantity: number;
  unit_cost: number;
  total_cost_amount: number;
  stock_movement_id: number;
  issued_at: string;
  notes: string | null;
};
type MaintenanceWorkOrderListRow = {
  work_order_id: number;
  work_order_number: string;
  generator_id: number;
  generator_name: string;
  preventive_plan_id: number | null;
  order_type: "breakdown" | "preventive" | "inspection" | "repair" | "other";
  priority: "low" | "normal" | "high" | "urgent";
  status: "scheduled" | "new" | "in_progress" | "waiting_for_parts" | "completed" | "cancelled";
  title: string;
  description: string | null;
  work_summary: string | null;
  reported_at: string;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  assigned_to_user_id: number | null;
  assigned_supplier_id: number | null;
  assigned_supplier_name: string | null;
  assigned_supplier_code: string | null;
  operating_hours_at_open: number | null;
  operating_hours_at_close: number | null;
  downtime_minutes: number;
  labor_cost: number;
  external_service_cost: number;
  parts_cost: number;
  total_cost_amount: number;
  created_by_user_id: number | null;
};
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
      "MAINTENANCE_PLAN_HOURS_DUE_REQUIRED", "MAINTENANCE_PLAN_OUT_OF_SCOPE",
      "MAINTENANCE_PREVENTIVE_PLAN_REQUIRED", "INVALID_MAINTENANCE_REPORT_RANGE",
      "MAINTENANCE_SUPPLIER_OUT_OF_SCOPE",
      "generator_maintenance_work_orders_preventive_open_plan_unique"
    ].find((candidate) => message.includes(candidate));
    if (code) throw new TRPCError({ code: "BAD_REQUEST", message: code === "generator_maintenance_work_orders_preventive_open_plan_unique" ? "توجد بالفعل مهمة صيانة وقائية مفتوحة لهذه الخطة. أكملها أو ألغها قبل إنشاء أمر جديد." : code === "INVALID_MAINTENANCE_REPORT_RANGE" ? "نطاق التقرير غير صحيح؛ اختر تاريخ بداية ونهاية خلال مدة لا تتجاوز 366 يومًا." : code === "MAINTENANCE_SUPPLIER_OUT_OF_SCOPE" ? "المورد غير نشط أو لا ينتمي إلى حسابك." : code });
    console.error("[PowerHub maintenance RPC]", { name, code: error.code });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تنفيذ عملية الصيانة. تحقق من البيانات والصلاحيات ثم أعد المحاولة." });
  }
  return data as T;
};

export const powerhubMaintenanceRouter = router({
  listGenerators: authenticatedProcedure
    .input(z.object({ siteId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireMaintenanceReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin()
        .from("generators")
        .select("id,name,code")
        .eq("tenant_id", access.tenantId)
        .eq("site_id", input.siteId)
        .order("name", { ascending: true });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مولدات الفرع للصيانة." });
      return (data ?? []).map((row) => ({ id: Number(row.id), name: row.name, code: row.code }));
    }),

  reportByGenerator: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(),
    fromDate: z.string().refine(isDateOnly, { message: "تاريخ البداية غير صالح." }),
    toDate: z.string().refine(isDateOnly, { message: "تاريخ النهاية غير صالح." }),
    generatorId: z.number().int().positive().optional(),
  })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...readRoles], "viewInventoryReports");
    return rpc<MaintenanceReportRow[]>("powerhub_maintenance_report_by_generator", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId,
      p_from_date: input.fromDate, p_to_date: input.toDate, p_generator_id: input.generatorId ?? null,
    });
  }),
  listAssignableSuppliers: authenticatedProcedure.input(z.object({ siteId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...maintenanceRoles], "manageMaintenance");
    const { data, error } = await supabaseAdmin().from("suppliers")
      .select("id,supplier_code,name").eq("tenant_id", access.tenantId).eq("is_active", true)
      .order("name", { ascending: true }).limit(250);
    if (error) {
      console.error("[PowerHub maintenance suppliers]", { code: error.code });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قائمة الموردين النشطين." });
    }
    return (data ?? []) as MaintenanceAssignableSupplierRow[];
  }),
  assignSupplier: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(), workOrderId: z.number().int().positive(),
    supplierId: z.number().int().positive().nullable(), operationKey,
  })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...maintenanceRoles], "manageMaintenance");
    return rpc("powerhub_maintenance_assign_supplier", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
      p_work_order_id: input.workOrderId, p_supplier_id: input.supplierId, p_operation_key: input.operationKey,
    });
  }),
  listWorkOrders: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(),
    generatorId: z.number().int().positive().optional(),
    status: z.enum(["scheduled", "new", "in_progress", "waiting_for_parts", "completed", "cancelled"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })).query(async ({ ctx, input }) => {
    const access = await requireMaintenanceReadAccess(ctx.user.id, input.siteId);
    return rpc<MaintenanceWorkOrderListRow[]>("powerhub_maintenance_list_work_orders", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId,
      p_generator_id: input.generatorId ?? null, p_status: input.status ?? null, p_limit: input.limit,
    });
  }),
  listPreventivePlans: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(), generatorId: z.number().int().positive().optional(),
  })).query(async ({ ctx, input }) => {
    const access = await requireMaintenanceReadAccess(ctx.user.id, input.siteId);
    return rpc<MaintenancePreventivePlanListRow[]>("powerhub_maintenance_list_preventive_plans", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_generator_id: input.generatorId ?? null,
    });
  }),
  evaluateDuePlans: authenticatedProcedure.input(z.object({ siteId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...maintenanceRoles], "manageMaintenance");
    return rpc("powerhub_maintenance_evaluate_due_plans", { p_tenant_id: access.tenantId, p_site_id: input.siteId });
  }),
  listParts: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(), workOrderId: z.number().int().positive(),
  })).query(async ({ ctx, input }) => {
    const access = await requireMaintenanceReadAccess(ctx.user.id, input.siteId);
    return rpc<MaintenancePartListRow[]>("powerhub_maintenance_list_parts", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_work_order_id: input.workOrderId,
    });
  }),
  createWorkOrder: authenticatedProcedure.input(z.object({
    siteId: z.number().int().positive(), generatorId: z.number().int().positive(),
    orderType: z.enum(["breakdown", "preventive", "inspection", "repair", "other"]),
    preventivePlanId: z.number().int().positive().optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    title: z.string().trim().min(3).max(180), description: z.string().max(5000).optional(),
    reportedAt: z.string().datetime().optional(), scheduledFor: z.string().datetime().optional(),
    assignedToUserId: z.number().int().positive().optional(), operationKey,
  }).superRefine((value, issue) => {
    if (value.orderType === "preventive" && !value.preventivePlanId) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["preventivePlanId"], message: "اختر خطة الصيانة الوقائية المرتبطة بالأمر." });
    if (value.orderType !== "preventive" && value.preventivePlanId) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["preventivePlanId"], message: "لا يمكن ربط خطة وقائية بأمر من نوع آخر." });
  })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...maintenanceRoles], "manageMaintenance");
    return rpc("powerhub_maintenance_create_work_order", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
      p_generator_id: input.generatorId, p_preventive_plan_id: input.preventivePlanId ?? null,
      p_order_type: input.orderType, p_priority: input.priority,
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
    if (input.action === "complete" && (input.laborCost > 0 || input.externalServiceCost > 0)
        && !access.permissions.includes("manageExpenses")) {
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
