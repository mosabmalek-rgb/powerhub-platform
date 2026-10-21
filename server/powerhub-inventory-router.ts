import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireSupabaseSiteRole, resolveSupabaseSiteAccess } from "./powerhub-supabase";
import { supabaseAdmin } from "./supabase-admin";

const roles = ["owner", "manager", "accountant", "collector", "technician", "viewer"] as const;

type InventoryStockOverviewRow = {
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  item_id: number;
  sku: string | null;
  item_name: string;
  category: string;
  base_unit: string;
  reorder_point: number | string;
  on_hand_quantity: number | string;
  stock_value: number | string;
  average_unit_cost: number | string;
  below_reorder_point: boolean;
};

type InventoryStockMovementRow = {
  movement_id: number;
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  item_id: number;
  sku: string | null;
  item_name: string;
  base_unit: string;
  generator_id: number | null;
  movement_type: string;
  quantity: number | string;
  unit_cost: number | string;
  total_cost_amount: number | string;
  reference_no: string | null;
  notes: string | null;
  operation_key: string;
  occurred_at: string;
  created_by_user_id: number | null;
  created_at: string;
  source_issue_movement_id?: number | null;
  returnable_quantity?: number | string;
};

const categorySchema = z.enum(["fuel", "oil", "filter", "spare_part", "maintenance_supply", "other"]);
const unitSchema = z.enum(["liter", "milliliter", "piece", "container", "kg", "gram", "meter", "set", "gallon", "other"]);

function mapDatabaseError(error: { code?: string } | null, operation: string): never {
  if (error?.code === "23505") {
    throw new TRPCError({ code: "CONFLICT", message: "يوجد سجل بنفس الرمز أو البيانات الفريدة." });
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: operation });
}


function mapPurchaseDatabaseError(
  error: { code?: string; message?: string } | null,
  fallback: string,
): never {
  if (error?.code === "23505") {
    throw new TRPCError({ code: "CONFLICT", message: "يوجد رقم فاتورة أو مفتاح عملية مستخدم مسبقًا." });
  }
  const message = error?.message ?? "";
  const known: Record<string, { code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND" | "FORBIDDEN"; message: string }> = {
    INVALID_OPERATION_KEY: { code: "BAD_REQUEST", message: "مفتاح العملية غير صالح." },
    INVALID_STOCK_TRANSFER: { code: "BAD_REQUEST", message: "بيانات التحويل المخزني غير صالحة؛ اختر مخزنين مختلفين." },
    INVALID_STOCK_TRANSFER_QUANTITY: { code: "BAD_REQUEST", message: "كمية التحويل غير صالحة أو تتجاوز ثلاث منازل عشرية." },
    STOCK_DESTINATION_WAREHOUSE_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المخزن المستلم غير نشط أو لا يتبع هذا الفرع." },
    STOCK_MOVEMENT_NOT_FOUND: { code: "NOT_FOUND", message: "حركة المخزون غير موجودة في هذا الفرع." },
    STOCK_MOVEMENT_NOT_RETURNABLE: { code: "BAD_REQUEST", message: "يمكن إرجاع الصرف اليدوي المؤهل فقط." },
    RETURN_FROM_ISSUE_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لإرجاع الصرف." },
    RETURN_FROM_ISSUE_EXCEEDS_UNRETURNED_QUANTITY: { code: "CONFLICT", message: "الكمية تتجاوز الكمية المصروفة المتبقية للإرجاع." },
    RETURN_FROM_ISSUE_COST_RECONCILIATION_FAILED: { code: "CONFLICT", message: "تعذر مطابقة تكلفة المرتجع مع تكلفة الصرف الأصلي." },
    INVENTORY_BALANCE_INVALID: { code: "CONFLICT", message: "رصيد المخزون غير متزن؛ أوقفنا الإرجاع لحماية السجلات." },
    STOCK_MOVEMENT_NOT_EDITABLE: { code: "BAD_REQUEST", message: "هذا النوع من الحركات لا يقبل التعديل المباشر؛ عدّل المستند الأصلي أو سجّل تسوية." },
    STOCK_MOVEMENT_ALREADY_CORRECTED: { code: "CONFLICT", message: "سبق تصحيح هذه الحركة." },
    STOCK_MOVEMENT_NOT_LATEST: { code: "CONFLICT", message: "لا يمكن تعديل حركة سبقتها حركة أحدث للصنف نفسه؛ استخدم تسوية مخزون جديدة." },
    STOCK_MOVEMENT_CORRECTION_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا للتعديل (3 أحرف على الأقل)." },
    STOCK_MOVEMENT_CORRECTION_WOULD_NEGATE_BALANCE: { code: "CONFLICT", message: "التعديل سيؤدي إلى رصيد أو قيمة مخزون سالبة." },
    STOCK_MOVEMENT_CORRECTION_COST_NEGATIVE: { code: "CONFLICT", message: "التعديل سيؤدي إلى قيمة مخزون سالبة." },
    STOCK_MOVEMENT_CORRECTION_INCOMPLETE: { code: "CONFLICT", message: "لم يكتمل سجل التصحيح؛ أوقفنا إعادة المحاولة." },
    STOCK_MOVEMENT_DIRECT_UPDATE_WAS_ACCEPTED: { code: "CONFLICT", message: "سجل الحركة غير قابل للتعديل المباشر." },
    INVALID_STOCK_REFERENCE: { code: "BAD_REQUEST", message: "رقم مرجع الحركة أطول من المسموح." },
    INVALID_STOCK_NOTES: { code: "BAD_REQUEST", message: "ملاحظات الحركة أطول من المسموح." },
    FUEL_MOVEMENT_SCOPE_INVALID: { code: "BAD_REQUEST", message: "المولد أو صنف الوقود المرتبط بالحركة غير صالح." },
    INVALID_PURCHASE_LINES: { code: "BAD_REQUEST", message: "تحقق من بنود فاتورة المشتريات والكميات والأسعار." },
    INVALID_RECEIPT_LINES: { code: "BAD_REQUEST", message: "تحقق من كميات الاستلام." },
    INVALID_PAYMENT_TERMS: { code: "BAD_REQUEST", message: "مدة السداد غير صالحة." },
    INVALID_DUE_DATE: { code: "BAD_REQUEST", message: "تاريخ الاستحقاق لا يجوز أن يسبق تاريخ الفاتورة." },
    PURCHASE_NOT_FOUND: { code: "NOT_FOUND", message: "فاتورة المشتريات غير موجودة في هذا الفرع." },
    SUPPLIER_RETURN_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لمرتجع المورد." },
    INVALID_SUPPLIER_RETURN_LINES: { code: "BAD_REQUEST", message: "تحقق من بنود وكميات مرتجع المورد." },
    DUPLICATE_OR_INVALID_SUPPLIER_RETURN_LINE: { code: "BAD_REQUEST", message: "لا تكرر بند الفاتورة نفسه في المرتجع." },
    SUPPLIER_RETURN_EXCEEDS_UNRETURNED_RECEIPT: { code: "CONFLICT", message: "كمية المرتجع تتجاوز الكمية المستلمة المتبقية بعد المرتجعات السابقة." },
    PURCHASE_RECEIPT_QUANTITY_MISMATCH: { code: "CONFLICT", message: "سجل الاستلام لا يطابق كميات الفاتورة؛ أوقفنا المرتجع لحماية المخزون." },
    SUPPLIER_RETURN_PURCHASE_NOT_RECEIVABLE: { code: "CONFLICT", message: "يمكن إرجاع البنود المستلمة فقط من فاتورة غير ملغاة." },
    INVALID_SUPPLIER_RETURN_REFUND: { code: "BAD_REQUEST", message: "مبلغ الاسترداد النقدي غير صالح." },
    SUPPLIER_RETURN_REFUND_ACCOUNT_REQUIRED: { code: "BAD_REQUEST", message: "حدد حساب الشركة إذا كان المورد سيرد مبلغًا نقديًا." },
    SUPPLIER_RETURN_REFUND_EXCEEDS_CREDIT: { code: "BAD_REQUEST", message: "مبلغ الاسترداد يتجاوز قيمة المرتجع." },
    INSUFFICIENT_STOCK_FOR_SUPPLIER_RETURN: { code: "CONFLICT", message: "الرصيد المتاح لا يكفي لإرجاع الكمية المحددة؛ راجع المخزون أولًا." },
    PURCHASE_LINE_NOT_FOUND: { code: "NOT_FOUND", message: "أحد بنود المشتريات غير موجود." },
    SUPPLIER_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المورد غير نشط أو لا ينتمي إلى الشركة." },
    WAREHOUSE_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المخزن غير نشط أو لا يتبع هذا الفرع." },
    ITEM_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "أحد الأصناف غير نشط أو لا ينتمي إلى الشركة." },
    OVER_RECEIPT: { code: "CONFLICT", message: "كمية الاستلام تتجاوز الكمية المتبقية في الفاتورة." },
    PURCHASE_NOT_RECEIVABLE: { code: "CONFLICT", message: "لا يمكن استلام هذه الفاتورة قبل اعتمادها أو بعد اكتمالها." },
    PURCHASE_STATE_CONFLICT: { code: "CONFLICT", message: "حالة فاتورة المشتريات لا تسمح بهذه العملية." },
    PURCHASE_CANNOT_BE_CANCELLED_AFTER_RECEIPT: { code: "CONFLICT", message: "لا يمكن إلغاء فاتورة بعد تسجيل أي استلام أو حركة مخزون." },
    PURCHASE_HAS_POSTED_PAYMENTS: { code: "CONFLICT", message: "لا يمكن إلغاء الفاتورة قبل عكس دفعات المورد المسجلة." },
    PURCHASE_CANCELLATION_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لإلغاء فاتورة المشتريات." },
    SUPPLIER_PAYMENT_NOT_FOUND: { code: "NOT_FOUND", message: "دفعة المورد غير موجودة في هذا الفرع." },
    SUPPLIER_PAYMENT_ALLOCATION_NOT_FOUND: { code: "CONFLICT", message: "لا يوجد تخصيص فاتورة صالح لهذه الدفعة." },
    SUPPLIER_PAYMENT_ALLOCATION_MISMATCH: { code: "CONFLICT", message: "تخصيص الدفعة لا يطابق فاتورة المورد؛ أوقفنا العكس لحماية الأرصدة." },
    SUPPLIER_PAYMENT_ORIGINAL_TRANSACTION_MISMATCH: { code: "CONFLICT", message: "تعذر مطابقة حركة السحب الأصلية في حساب الشركة؛ لم يُسجل أي عكس." },
    SUPPLIER_PAYMENT_REVERSAL_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سببًا واضحًا لعكس دفعة المورد." },
    IDEMPOTENCY_KEY_REUSED: { code: "CONFLICT", message: "مفتاح العملية مستخدم بطلب مختلف؛ أنشئ مفتاحًا جديدًا." },
    DUPLICATE_PURCHASE_LINE: { code: "BAD_REQUEST", message: "لا تكرر بند الفاتورة نفسه ضمن طلب الاستلام الواحد." },
    INVALID_SUPPLIER_PAYMENT_AMOUNT: { code: "BAD_REQUEST", message: "مبلغ دفعة المورد يجب أن يكون موجبًا وبحد أقصى منزلتين عشريتين." },
    COMPANY_ACCOUNT_NOT_FOUND: { code: "NOT_FOUND", message: "حساب الشركة غير موجود." },
    COMPANY_ACCOUNT_INACTIVE: { code: "BAD_REQUEST", message: "حساب الشركة غير نشط ولا يمكن الدفع منه." },
    COMPANY_ACCOUNT_OUT_OF_SCOPE: { code: "FORBIDDEN", message: "حساب الشركة غير متاح لهذا الفرع." },
    INSUFFICIENT_ACCOUNT_BALANCE: { code: "BAD_REQUEST", message: "رصيد حساب الشركة لا يكفي لهذه الدفعة." },
    FINANCIAL_PERIOD_LOCKED: { code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تسجيل هذه الحركة خلال الفترة المقفلة." },
    INVALID_STOCK_MOVEMENT: { code: "BAD_REQUEST", message: "نوع حركة المخزون غير صالح." },
    INVALID_STOCK_QUANTITY: { code: "BAD_REQUEST", message: "أدخل كمية موجبة لا تتجاوز ثلاث منازل عشرية." },
    INVALID_STOCK_UNIT_COST: { code: "BAD_REQUEST", message: "تكلفة الوحدة غير صالحة أو لا تتوافق مع نوع الحركة." },
    STOCK_ADJUSTMENT_REASON_REQUIRED: { code: "BAD_REQUEST", message: "أدخل سبب تسوية الجرد." },
    OPENING_BALANCE_ALREADY_EXISTS: { code: "CONFLICT", message: "تم تسجيل رصيد افتتاحي لهذا الصنف في المخزن؛ استخدم تسوية جرد موثقة بدل تكراره." },
    STOCK_UNIT_COST_REQUIRED: { code: "BAD_REQUEST", message: "أدخل تكلفة الوحدة عند إضافة كمية لصنف بلا رصيد سابق." },
    STOCK_ITEM_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "الصنف غير نشط أو لا ينتمي إلى هذه الشركة." },
    STOCK_WAREHOUSE_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المخزن غير نشط أو لا يتبع هذا الفرع." },
    STOCK_GENERATOR_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المولد المحدد لا يتبع هذه الشركة أو الفرع." },
    GENERATOR_REQUIRED: { code: "BAD_REQUEST", message: "اختر المولد المرتبط باستهلاك الوقود." },
    FUEL_ITEM_REQUIRED: { code: "BAD_REQUEST", message: "استهلاك الوقود متاح لأصناف الوقود فقط." },
    INSUFFICIENT_STOCK: { code: "CONFLICT", message: "الكمية المتاحة لا تكفي لهذه الحركة؛ حدّث الرصيد وحاول مجددًا." },
    PURCHASE_BALANCE_EXCEEDED: { code: "CONFLICT", message: "مبلغ الدفعة يتجاوز المتبقي من فاتورة المشتريات." },
    PURCHASE_NOT_PAYABLE: { code: "CONFLICT", message: "لا يمكن دفع فاتورة مسودة أو ملغاة." },
    PURCHASE_HAS_NO_LINES: { code: "BAD_REQUEST", message: "لا يمكن اعتماد فاتورة بلا بنود." },
    SITE_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "الفرع المحدد غير متاح لهذه الشركة." },
  };
  const match = Object.entries(known).find(([key]) => message.includes(key));
  if (match) {
    const [, value] = match;
    throw new TRPCError({ code: value.code, message: value.message });
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: fallback });
}

async function requirePurchaseReadAccess(userId: number, siteId: number) {
  const access = await resolveSupabaseSiteAccess(userId, siteId);
  const canManageSupplierPayments = access.permissions.includes("manageSupplierPayments");
  const canViewFinancials = access.permissions.includes("viewPurchases") || canManageSupplierPayments;
  const canAdjustInventory = access.permissions.includes("adjustInventory");
  if (!canViewFinancials && !access.permissions.includes("receiveInventory") && !canAdjustInventory) {
    throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض المشتريات أو تنفيذ استلام أو مرتجع مخزني." });
  }
  return { ...access, canViewFinancials, canManageSupplierPayments };
}

async function requireStockReadAccess(userId: number, siteId: number) {
  const access = await resolveSupabaseSiteAccess(userId, siteId);
  if (!access.permissions.includes("viewInventory") && !access.permissions.includes("viewInventoryReports")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض أرصدة المخزون وحركاته." });
  }
  return access;
}

const purchaseStatusSchema = z.enum(["draft", "confirmed", "partially_received", "received", "cancelled"]);
const purchaseLineInputSchema = z.object({
  itemId: z.number().int().positive(),
  quantity: z.number().finite().positive().max(1_000_000_000),
  unit: z.string().trim().min(1).max(40),
  unitsToBaseFactor: z.number().finite().positive().max(1_000_000),
  unitPrice: z.number().finite().min(0).max(1_000_000_000),
  discountAmount: z.number().finite().min(0).max(1_000_000_000).default(0),
  taxAmount: z.number().finite().min(0).max(1_000_000_000).default(0),
  notes: z.string().trim().max(1000).optional(),
});

export const powerhubInventoryRouter = router({
  stockOverview: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireStockReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_stock_overview", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أرصدة المخزون." });
      if (access.permissions.includes("viewInventoryReports")) return data ?? [];
      return (data ?? []).map((row: InventoryStockOverviewRow) => {
        const { stock_value: _stockValue, average_unit_cost: _averageUnitCost, ...visible } = row;
        return visible;
      });
    }),

  listStockMovements: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ ctx, input }) => {
      const access = await requireStockReadAccess(ctx.user.id, input.siteId);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_list_stock_movements", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_limit: input.limit,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل حركات المخزون." });
      if (access.permissions.includes("viewInventoryReports")) return data ?? [];
      return (data ?? []).map((row: InventoryStockMovementRow) => {
        const { unit_cost: _unitCost, total_cost_amount: _totalCostAmount, ...visible } = row;
        return visible;
      });
    }),

  listStockMovementReport: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      limit: z.number().int().min(1).max(200).default(100),
      beforeOccurredAt: z.string().datetime().optional(),
      beforeMovementId: z.number().int().positive().optional(),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      warehouseId: z.number().int().positive().optional(),
      search: z.string().trim().max(150).optional(),
    }).refine((value) => Boolean(value.beforeOccurredAt) === Boolean(value.beforeMovementId), {
      message: "مؤشر صفحة الحركات غير مكتمل.",
    }).refine((value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate, {
      message: "نطاق تاريخ الحركات غير صحيح.",
    }))
    .query(async ({ ctx, input }) => {
      const access = await requireStockReadAccess(ctx.user.id, input.siteId);
      if (!access.permissions.includes("viewInventoryReports")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض أو تصدير تقارير المخزون." });
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_list_stock_movement_report", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_limit: input.limit + 1,
        p_before_occurred_at: input.beforeOccurredAt ?? null,
        p_before_movement_id: input.beforeMovementId ?? null,
        p_from_date: input.fromDate ?? null,
        p_to_date: input.toDate ?? null,
        p_warehouse_id: input.warehouseId ?? null,
        p_search: input.search?.trim() || null,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تقرير حركات المخزون." });
      const rows = (data ?? []) as InventoryStockMovementRow[];
      const hasMore = rows.length > input.limit;
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
      const items = pageRows.map((row) => ({
        movement_id: row.movement_id,
        warehouse_id: row.warehouse_id,
        warehouse_code: row.warehouse_code,
        warehouse_name: row.warehouse_name,
        item_id: row.item_id,
        sku: row.sku,
        item_name: row.item_name,
        base_unit: row.base_unit,
        movement_type: row.movement_type,
        quantity: row.quantity,
        total_cost_amount: row.total_cost_amount,
        reference_no: row.reference_no,
        notes: row.notes,
        occurred_at: row.occurred_at,
      }));
      const last = pageRows[pageRows.length - 1];
      return {
        items,
        hasMore,
        nextCursor: hasMore && last ? { beforeOccurredAt: last.occurred_at, beforeMovementId: Number(last.movement_id) } : null,
      };
    }),

  recordStockMovement: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      warehouseId: z.number().int().positive(),
      itemId: z.number().int().positive(),
      movementType: z.enum(["issue", "opening_balance", "adjustment_in", "adjustment_out", "fuel_consumption"]),
      quantity: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "الكمية تقبل ثلاث منازل عشرية كحد أقصى."),
      unitCost: z.number().finite().min(0).max(1_000_000_000)
        .refine((value) => Math.abs(value * 10000 - Math.round(value * 10000)) < 1e-7, "تكلفة الوحدة تقبل أربع منازل عشرية كحد أقصى.")
        .optional(),
      generatorId: z.number().int().positive().optional(),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      operationKey: z.string().trim().min(1).max(180),
    }).refine((value) =>
      (["adjustment_in", "opening_balance"].includes(value.movementType) || value.unitCost === undefined),
      { message: "تكلفة الوحدة المدخلة تستخدم فقط عند الرصيد الافتتاحي أو تسوية زيادة المخزون.", path: ["unitCost"] }
    ).refine((value) =>
      (value.movementType !== "opening_balance" || value.unitCost !== undefined),
      { message: "أدخل تكلفة الوحدة للرصيد الافتتاحي.", path: ["unitCost"] }
    ).refine((value) =>
      (value.movementType !== "fuel_consumption" || value.generatorId !== undefined),
      { message: "اختر المولد المرتبط باستهلاك الوقود.", path: ["generatorId"] }
    ).refine((value) =>
      (!["opening_balance", "adjustment_in", "adjustment_out"].includes(value.movementType) || Boolean(value.notes?.trim())),
      { message: "أدخل سبب تسوية الجرد.", path: ["notes"] }
    ))
    .mutation(async ({ ctx, input }) => {
      const requiredCapability = input.movementType === "issue"
        ? "issueInventory"
        : input.movementType === "fuel_consumption"
          ? "manageFuelAndConsumption"
          : "adjustInventory";
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], requiredCapability);
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_record_stock_movement", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_warehouse_id: input.warehouseId,
        p_item_id: input.itemId,
        p_movement_type: input.movementType,
        p_quantity: input.quantity,
        p_unit_cost: input.unitCost ?? null,
        p_generator_id: input.generatorId ?? null,
        p_reference_no: input.referenceNo || null,
        p_notes: input.notes || null,
        p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تسجيل حركة المخزون.");
      return data[0];
    }),


  returnFromIssue: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      sourceIssueMovementId: z.number().int().positive(),
      quantity: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "الكمية تقبل ثلاث منازل عشرية كحد أقصى."),
      reason: z.string().trim().min(3).max(500),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      operationKey: z.string().trim().min(1).max(180),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "adjustInventory");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_return_from_issue", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_source_issue_movement_id: input.sourceIssueMovementId,
        p_quantity: input.quantity,
        p_reason: input.reason,
        p_reference_no: input.referenceNo || null,
        p_notes: input.notes || null,
        p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر إرجاع الصرف إلى المخزون.");
      return data[0];
    }),

  correctStockMovement: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      movementId: z.number().int().positive(),
      quantity: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "الكمية تقبل ثلاث منازل عشرية كحد أقصى."),
      unitCost: z.number().finite().min(0).max(1_000_000_000)
        .refine((value) => Math.abs(value * 10000 - Math.round(value * 10000)) < 1e-7, "تكلفة الوحدة تقبل أربع منازل عشرية كحد أقصى.")
        .optional(),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      reason: z.string().trim().min(3).max(500),
      operationKey: z.string().trim().min(1).max(160),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "adjustInventory");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_correct_stock_movement", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_movement_id: input.movementId,
        p_quantity: input.quantity,
        p_unit_cost: input.unitCost ?? null,
        p_reference_no: input.referenceNo || null,
        p_notes: input.notes || null,
        p_reason: input.reason,
        p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تصحيح حركة المخزون.");
      return data[0];
    }),

  listItems: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), search: z.string().trim().max(100).optional(), includeInactive: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewInventory");
      let query = supabaseAdmin().from("inventory_items")
        .select("id,tenant_id,sku,name,category,base_unit,reorder_point,specification,notes,is_active,created_at,updated_at")
        .eq("tenant_id", access.tenantId)
        .order("name", { ascending: true })
        .limit(500);
      if (!input.includeInactive) query = query.eq("is_active", true);
      if (input.search) {
        const safeSearch = input.search.replace(/[%,*()]/g, " ").replace(/[,]/g, " ").trim();
        if (safeSearch) query = query.or(`name.ilike.%${safeSearch}%,sku.ilike.%${safeSearch}%`);
      }
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل دليل الأصناف." });
      return data ?? [];
    }),

  createItem: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      sku: z.string().trim().max(80).optional(),
      name: z.string().trim().min(1).max(180),
      category: categorySchema,
      baseUnit: unitSchema,
      reorderPoint: z.number().finite().min(0).max(1_000_000_000).default(0),
      specification: z.string().trim().max(500).optional(),
      notes: z.string().trim().max(2000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageInventoryItems");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_create_item", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_sku: input.sku || null,
        p_name: input.name,
        p_category: input.category,
        p_base_unit: input.baseUnit,
        p_reorder_point: input.reorderPoint,
        p_specification: input.specification || null,
        p_notes: input.notes || null,
      });
      if (error || !data?.[0]) mapDatabaseError(error, "تعذر إضافة الصنف إلى الدليل الموحد.");
      return data[0];
    }),

  listSuppliers: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), search: z.string().trim().max(100).optional(), includeInactive: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewSuppliers");
      let query = supabaseAdmin().from("suppliers")
        .select("id,tenant_id,supplier_code,name,contact_name,phone,email,address,tax_number,default_payment_terms_days,notes,is_active,created_at,updated_at")
        .eq("tenant_id", access.tenantId)
        .order("name", { ascending: true })
        .limit(500);
      if (!input.includeInactive) query = query.eq("is_active", true);
      if (input.search) {
        const safeSearch = input.search.replace(/[%,*()]/g, " ").replace(/[,]/g, " ").trim();
        if (safeSearch) query = query.or(`name.ilike.%${safeSearch}%,supplier_code.ilike.%${safeSearch}%,phone.ilike.%${safeSearch}%`);
      }
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل دليل الموردين." });
      return data ?? [];
    }),

  createSupplier: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      supplierCode: z.string().trim().max(80).optional(),
      name: z.string().trim().min(1).max(180),
      contactName: z.string().trim().max(180).optional(),
      phone: z.string().trim().max(40).optional(),
      email: z.string().trim().email().max(254).optional().or(z.literal("")),
      address: z.string().trim().max(500).optional(),
      taxNumber: z.string().trim().max(100).optional(),
      defaultPaymentTermsDays: z.number().int().min(0).max(3650).default(0),
      notes: z.string().trim().max(2000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSuppliers");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_create_supplier", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_supplier_code: input.supplierCode || null,
        p_name: input.name,
        p_contact_name: input.contactName || null,
        p_phone: input.phone || null,
        p_email: input.email || null,
        p_address: input.address || null,
        p_tax_number: input.taxNumber || null,
        p_default_payment_terms_days: input.defaultPaymentTermsDays,
        p_notes: input.notes || null,
      });
      if (error || !data?.[0]) mapDatabaseError(error, "تعذر إضافة المورد.");
      return data[0];
    }),

  listWarehouses: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), includeInactive: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewInventory");
      let query = supabaseAdmin().from("inventory_warehouses")
        .select("id,tenant_id,site_id,code,name,notes,is_active,created_at,updated_at")
        .eq("tenant_id", access.tenantId)
        .eq("site_id", input.siteId)
        .order("name", { ascending: true })
        .limit(200);
      if (!input.includeInactive) query = query.eq("is_active", true);
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قائمة المخازن." });
      return data ?? [];
    }),

  createWarehouse: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      code: z.string().trim().min(1).max(40),
      name: z.string().trim().min(1).max(120),
      notes: z.string().trim().max(2000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageInventoryItems");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_create_warehouse", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_code: input.code,
        p_name: input.name,
        p_notes: input.notes || null,
      });
      if (error || !data?.[0]) mapDatabaseError(error, "تعذر إنشاء المخزن.");
      return data[0];
    }),

  listPurchaseOptions: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "createPurchases");
      const [supplierResult, warehouseResult, itemResult] = await Promise.all([
        supabaseAdmin().from("suppliers").select("id,name,supplier_code")
          .eq("tenant_id", access.tenantId).eq("is_active", true).order("name", { ascending: true }).limit(300),
        supabaseAdmin().from("inventory_warehouses").select("id,name,code")
          .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("is_active", true).order("name", { ascending: true }).limit(200),
        supabaseAdmin().from("inventory_items").select("id,name,sku,base_unit")
          .eq("tenant_id", access.tenantId).eq("is_active", true).order("name", { ascending: true }).limit(500),
      ]);
      if (supplierResult.error || warehouseResult.error || itemResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل خيارات إنشاء المشتريات." });
      }
      return { suppliers: supplierResult.data ?? [], warehouses: warehouseResult.data ?? [], items: itemResult.data ?? [] };
    }),

  listSupplierPaymentOptions: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments");
      const { data: accountRows, error: accountError } = await supabaseAdmin().from("company_accounts")
        .select("id,tenant_id,name,account_type,is_active")
        .eq("tenant_id", access.tenantId).eq("is_active", true)
        .order("name", { ascending: true }).limit(500);
      if (accountError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حسابات الشركة المتاحة للدفع." });
      const rows = accountRows ?? [];
      if (!rows.length) return [];
      const accountIds = rows.map((account) => Number(account.id));
      const { data: siteLinks, error: siteLinksError } = await supabaseAdmin().from("company_account_sites")
        .select("account_id,site_id").eq("tenant_id", access.tenantId).in("account_id", accountIds);
      if (siteLinksError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من ربط الحسابات بالفروع." });
      const linksByAccount = new Map<number, number[]>();
      for (const link of siteLinks ?? []) {
        const id = Number(link.account_id);
        linksByAccount.set(id, [...(linksByAccount.get(id) ?? []), Number(link.site_id)]);
      }
      // No links means a tenant-wide company account. Explicitly linked accounts
      // are shown only for one of their configured branches.
      const visible = rows.filter((account) => {
        const sites = linksByAccount.get(Number(account.id)) ?? [];
        return sites.length === 0 || sites.includes(input.siteId);
      });
      if (!visible.length) return [];
      const visibleIds = visible.map((account) => Number(account.id));
      const { data: balances, error: balanceError } = await supabaseAdmin().rpc("powerhub_company_account_balance_rollup", {
        p_tenant_id: access.tenantId, p_account_ids: visibleIds,
      });
      if (balanceError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر احتساب الأرصدة الحالية لحسابات الشركة." });
      const balanceById = new Map<number, number>((balances ?? []).map((row: { account_id: number | string; balance: number | string }) => [
        Number(row.account_id), Number(row.balance),
      ]));
      return visible.map((account) => {
        const balance = balanceById.get(Number(account.id));
        if (balance === undefined || !Number.isFinite(balance)) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم يُرجع حساب الشركة رصيدًا صالحًا." });
        }
        return { id: Number(account.id), name: account.name, accountType: account.account_type, balance };
      });
    }),

  listPurchases: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), search: z.string().trim().max(100).optional(), status: purchaseStatusSchema.optional() }))
    .query(async ({ ctx, input }) => {
      const access = await requirePurchaseReadAccess(ctx.user.id, input.siteId);
      let query = supabaseAdmin().from("supplier_purchases")
        .select("id,tenant_id,site_id,supplier_id,warehouse_id,purchase_number,supplier_invoice_no,invoice_date,due_date,status,subtotal_amount,discount_amount,tax_amount,other_charges_amount,total_amount,payment_terms_days,reference_no,notes,operation_key,received_at,received_by_user_id,confirmed_at,confirmed_by_user_id,created_by_user_id,created_at,updated_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
        .order("invoice_date", { ascending: false }).order("id", { ascending: false }).limit(200);
      if (!access.canViewFinancials) query = query.in("status", ["confirmed", "partially_received", "received"]);
      if (input.status) query = query.eq("status", input.status);
      if (input.search) {
        const safeSearch = input.search.replace(/[%,*(),]/g, " ").trim();
        if (safeSearch) query = query.or(`purchase_number.ilike.%${safeSearch}%,supplier_invoice_no.ilike.%${safeSearch}%,reference_no.ilike.%${safeSearch}%`);
      }
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل فواتير المشتريات." });
      const purchases = data ?? [];
      if (!purchases.length) return [];
      const supplierIds = [...new Set(purchases.map((purchase) => Number(purchase.supplier_id)))];
      const warehouseIds = [...new Set(purchases.map((purchase) => Number(purchase.warehouse_id)))];
      const [supplierResult, warehouseResult] = await Promise.all([
        supabaseAdmin().from("suppliers").select("id,name,supplier_code").eq("tenant_id", access.tenantId).in("id", supplierIds),
        supabaseAdmin().from("inventory_warehouses").select("id,name,code").eq("tenant_id", access.tenantId).in("id", warehouseIds),
      ]);
      if (supplierResult.error || warehouseResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات الموردين والمخازن المرتبطة بالمشتريات." });
      }
      const suppliers = new Map((supplierResult.data ?? []).map((row) => [Number(row.id), row]));
      const warehouses = new Map((warehouseResult.data ?? []).map((row) => [Number(row.id), row]));
      return purchases.map((purchase) => ({
        ...purchase,
        supplierName: suppliers.get(Number(purchase.supplier_id))?.name ?? "مورد غير متاح",
        supplierCode: suppliers.get(Number(purchase.supplier_id))?.supplier_code ?? null,
        warehouseName: warehouses.get(Number(purchase.warehouse_id))?.name ?? "مخزن غير متاح",
        canViewFinancials: access.canViewFinancials,
        ...(access.canViewFinancials ? {} : {
          supplier_invoice_no: null, due_date: null, subtotal_amount: null, discount_amount: null,
          tax_amount: null, other_charges_amount: null, total_amount: null, payment_terms_days: null,
          reference_no: null, notes: null,
        }),
      }));
    }),

  getPurchase: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), purchaseId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const access = await requirePurchaseReadAccess(ctx.user.id, input.siteId);
      const { data: purchase, error: purchaseError } = await supabaseAdmin().from("supplier_purchases")
        .select("id,tenant_id,site_id,supplier_id,warehouse_id,purchase_number,supplier_invoice_no,invoice_date,due_date,status,subtotal_amount,discount_amount,tax_amount,other_charges_amount,total_amount,payment_terms_days,reference_no,notes,operation_key,received_at,received_by_user_id,confirmed_at,confirmed_by_user_id,cancelled_at,cancelled_by_user_id,created_by_user_id,created_at,updated_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("id", input.purchaseId).maybeSingle();
      if (purchaseError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل فاتورة المشتريات." });
      if (!purchase || (!access.canViewFinancials && !["confirmed", "partially_received", "received"].includes(purchase.status))) {
        throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة المشتريات غير موجودة في هذا الفرع." });
      }
      const [lineResult, receiptResult, returnResult, returnCreditResult, supplierResult, warehouseResult] = await Promise.all([
        supabaseAdmin().from("supplier_purchase_lines")
          .select("id,tenant_id,purchase_id,item_id,quantity,unit,units_to_base_factor,unit_price,discount_amount,tax_amount,line_subtotal,line_total,received_quantity,notes,created_at,updated_at")
          .eq("tenant_id", access.tenantId).eq("purchase_id", input.purchaseId).order("id", { ascending: true }),
        supabaseAdmin().from("supplier_purchase_receipts")
          .select("id,receipt_number,receipt_date,operation_key,notes,received_at,received_by_user_id,created_at")
          .eq("tenant_id", access.tenantId).eq("purchase_id", input.purchaseId).order("id", { ascending: false }).limit(100),
        supabaseAdmin().from("supplier_purchase_returns")
          .select("id,return_number,return_date,status,reason,notes,total_credit_amount,stock_cost_amount,refund_amount,refund_company_account_id,returned_at,operation_key")
          .eq("tenant_id", access.tenantId).eq("purchase_id", input.purchaseId).order("id", { ascending: false }).limit(100),
        supabaseAdmin().rpc("powerhub_inventory_purchase_supplier_return_credit", {
          p_tenant_id: access.tenantId, p_purchase_id: input.purchaseId,
        }),
        supabaseAdmin().from("suppliers").select("id,name,supplier_code")
          .eq("tenant_id", access.tenantId).eq("id", purchase.supplier_id).maybeSingle(),
        supabaseAdmin().from("inventory_warehouses").select("id,name,code")
          .eq("tenant_id", access.tenantId).eq("id", purchase.warehouse_id).maybeSingle(),
      ]);
      if (lineResult.error || receiptResult.error || returnResult.error || supplierResult.error || warehouseResult.error || returnCreditResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل البنود والاستلام والمرتجعات وأثرها على المستحق." });
      }
      const itemIds = [...new Set((lineResult.data ?? []).map((line) => Number(line.item_id)))];
      const itemResult = itemIds.length
        ? await supabaseAdmin().from("inventory_items").select("id,name,sku,base_unit").eq("tenant_id", access.tenantId).in("id", itemIds)
        : { data: [], error: null };
      if (itemResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء الأصناف." });
      const items = new Map((itemResult.data ?? []).map((item) => [Number(item.id), item]));
      const returnIds = (returnResult.data ?? []).map((row) => Number(row.id));
      const returnLinesResult = returnIds.length
        ? await supabaseAdmin().from("supplier_purchase_return_lines")
          .select("id,return_id,purchase_line_id,stock_movement_id,quantity,base_quantity,supplier_credit_amount,inventory_unit_cost,stock_cost_amount")
          .eq("tenant_id", access.tenantId).in("return_id", returnIds).order("id", { ascending: true })
        : { data: [], error: null };
      if (returnLinesResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بنود مرتجعات المورد." });
      const purchaseLinesById = new Map((lineResult.data ?? []).map((line) => [Number(line.id), line]));
      type SupplierPurchaseReturnLineView = {
        id: number;
        return_id: number;
        purchase_line_id: number;
        stock_movement_id: number;
        quantity: number;
        base_quantity: number;
        supplier_credit_amount: number | null;
        inventory_unit_cost: number | null;
        stock_cost_amount: number | null;
        itemName: string;
        unit: string;
      };
      const returnLinesByReturn = new Map<number, SupplierPurchaseReturnLineView[]>();
      for (const line of returnLinesResult.data ?? []) {
        const returnId = Number(line.return_id);
        const purchaseLine = purchaseLinesById.get(Number(line.purchase_line_id));
        const item = purchaseLine ? items.get(Number(purchaseLine.item_id)) : undefined;
        const visibleLine: SupplierPurchaseReturnLineView = {
          id: Number(line.id),
          return_id: returnId,
          purchase_line_id: Number(line.purchase_line_id),
          stock_movement_id: Number(line.stock_movement_id),
          quantity: Number(line.quantity),
          base_quantity: Number(line.base_quantity),
          supplier_credit_amount: access.canViewFinancials ? Number(line.supplier_credit_amount ?? 0) : null,
          inventory_unit_cost: access.canViewFinancials ? Number(line.inventory_unit_cost ?? 0) : null,
          stock_cost_amount: access.canViewFinancials ? Number(line.stock_cost_amount ?? 0) : null,
          itemName: item?.name ?? "صنف غير متاح",
          unit: purchaseLine?.unit ?? "",
        };
        returnLinesByReturn.set(returnId, [...(returnLinesByReturn.get(returnId) ?? []), visibleLine]);
      }
      const returns = (returnResult.data ?? []).map((row) => {
        const returnId = Number(row.id);
        return {
          id: returnId,
          return_number: String(row.return_number ?? ""),
          return_date: String(row.return_date ?? ""),
          status: String(row.status ?? ""),
          reason: String(row.reason ?? ""),
          notes: typeof row.notes === "string" ? row.notes : null,
          total_credit_amount: access.canViewFinancials ? Number(row.total_credit_amount ?? 0) : null,
          stock_cost_amount: access.canViewFinancials ? Number(row.stock_cost_amount ?? 0) : null,
          refund_amount: access.canViewFinancials ? Number(row.refund_amount ?? 0) : null,
          refund_company_account_id: access.canViewFinancials && row.refund_company_account_id != null
            ? Number(row.refund_company_account_id) : null,
          returned_at: typeof row.returned_at === "string" ? row.returned_at : null,
          operation_key: String(row.operation_key ?? ""),
          lines: returnLinesByReturn.get(returnId) ?? [],
        };
      });
      const supplierReturnCreditAmount = access.canViewFinancials
        ? Number(returnCreditResult.data ?? 0)
        : null;

      let payments: Array<{
        id: number; amount: number; allocated_amount: number; payment_date: string;
        reference_no: string | null; company_account_id: number; company_account_name: string;
        account_transaction_id: number | null; posted_at: string | null;
        status: "posted" | "reversed"; reversal_reason: string | null;
      }> = [];
      let paidAmount = 0;
      if (access.canViewFinancials) {
        const { data: allocations, error: allocationError } = await supabaseAdmin().from("supplier_payment_allocations")
          .select("payment_id,amount").eq("tenant_id", access.tenantId).eq("purchase_id", input.purchaseId)
          .order("id", { ascending: false }).limit(200);
        if (allocationError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تخصيصات دفعات المورد." });
        const allocationByPayment = new Map<number, number>();
        for (const allocation of allocations ?? []) {
          const id = Number(allocation.payment_id);
          allocationByPayment.set(id, (allocationByPayment.get(id) ?? 0) + Number(allocation.amount));
        }
        const paymentIds = [...allocationByPayment.keys()];
        if (paymentIds.length) {
          const { data: paymentRows, error: paymentError } = await supabaseAdmin().from("supplier_payments")
            .select("id,amount,payment_date,reference_no,company_account_id,account_transaction_id,posted_at,status,reversal_reason")
            .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).in("id", paymentIds)
            .order("payment_date", { ascending: false }).order("id", { ascending: false });
          if (paymentError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل دفعات المورد." });
          const visiblePayments = paymentRows ?? [];
          const accountIds = [...new Set(visiblePayments.map((payment) => Number(payment.company_account_id)))];
          const { data: accountRows, error: accountError } = accountIds.length
            ? await supabaseAdmin().from("company_accounts").select("id,name")
              .eq("tenant_id", access.tenantId).in("id", accountIds)
            : { data: [], error: null };
          if (accountError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء حسابات دفعات المورد." });
          const accountNames = new Map((accountRows ?? []).map((account) => [Number(account.id), account.name]));
          payments = visiblePayments.map((payment) => ({
            id: Number(payment.id),
            amount: Number(payment.amount),
            allocated_amount: allocationByPayment.get(Number(payment.id)) ?? 0,
            payment_date: payment.payment_date,
            reference_no: payment.reference_no ?? null,
            company_account_id: Number(payment.company_account_id),
            company_account_name: accountNames.get(Number(payment.company_account_id)) ?? "حساب غير متاح",
            account_transaction_id: payment.account_transaction_id == null ? null : Number(payment.account_transaction_id),
            posted_at: payment.posted_at ?? null,
            status: payment.status as "posted" | "reversed",
            reversal_reason: payment.reversal_reason ?? null,
          }));
          paidAmount = payments.filter((payment) => payment.status === "posted")
            .reduce((sum, payment) => sum + payment.allocated_amount, 0);
        }
      }
      return {
        purchase: {
          ...purchase,
          supplierName: supplierResult.data?.name ?? "مورد غير متاح",
          supplierCode: supplierResult.data?.supplier_code ?? null,
          warehouseName: warehouseResult.data?.name ?? "مخزن غير متاح",
          canViewFinancials: access.canViewFinancials,
          ...(access.canViewFinancials ? {
            paidAmount,
            supplierReturnCreditAmount,
            outstandingAmount: Math.max(0, Number(purchase.total_amount) - paidAmount - Number(supplierReturnCreditAmount ?? 0)),
          } : {
            supplier_invoice_no: null, due_date: null, subtotal_amount: null, discount_amount: null, tax_amount: null,
            other_charges_amount: null, total_amount: null, payment_terms_days: null, reference_no: null, notes: null,
            paidAmount: null, supplierReturnCreditAmount: null, outstandingAmount: null,
          }),
        },
        canViewFinancials: access.canViewFinancials,
        payments,
        lines: (lineResult.data ?? []).map((line) => ({
          ...line,
          ...(access.canViewFinancials ? {} : {
            unit_price: null, discount_amount: null, tax_amount: null, line_subtotal: null, line_total: null, notes: null,
          }),
          itemName: items.get(Number(line.item_id))?.name ?? "صنف غير متاح",
          itemSku: items.get(Number(line.item_id))?.sku ?? null,
          baseUnit: items.get(Number(line.item_id))?.base_unit ?? null,
        })),
        receipts: receiptResult.data ?? [],
        returns,
      };
    }),

  createPurchase: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      supplierId: z.number().int().positive(),
      warehouseId: z.number().int().positive(),
      supplierInvoiceNo: z.string().trim().max(120).optional(),
      invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      paymentTermsDays: z.number().int().min(0).max(3650).optional(),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      operationKey: z.string().trim().min(1).max(180),
      lines: z.array(purchaseLineInputSchema).min(1).max(200),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "createPurchases");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_create_purchase", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_supplier_id: input.supplierId, p_warehouse_id: input.warehouseId,
        p_supplier_invoice_no: input.supplierInvoiceNo || null,
        p_invoice_date: input.invoiceDate || null, p_due_date: input.dueDate || null,
        p_payment_terms_days: input.paymentTermsDays ?? null,
        p_reference_no: input.referenceNo || null, p_notes: input.notes || null,
        p_operation_key: input.operationKey,
        p_lines: input.lines.map((line) => ({
          item_id: line.itemId, quantity: line.quantity, unit: line.unit,
          units_to_base_factor: line.unitsToBaseFactor, unit_price: line.unitPrice,
          discount_amount: line.discountAmount, tax_amount: line.taxAmount, notes: line.notes || null,
        })),
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر إنشاء مسودة فاتورة المشتريات.");
      return data[0];
    }),

  supplierLedgerStatement: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      supplierId: z.number().int().positive(),
      limit: z.number().int().min(1).max(500).default(200),
    }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewSupplierLedger");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_supplier_ledger_statement", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_supplier_id: input.supplierId, p_limit: input.limit,
      });
      if (error || !data) mapPurchaseDatabaseError(error, "تعذر تحميل كشف حساب المورد.");
      return data;
    }),

  cancelPurchase: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      purchaseId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "approvePurchases");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_cancel_purchase", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_purchase_id: input.purchaseId, p_reason: input.reason,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر إلغاء فاتورة المشتريات.");
      return data[0];
    }),

  reverseSupplierPayment: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      paymentId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_reverse_supplier_payment", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_payment_id: input.paymentId, p_reason: input.reason,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر عكس دفعة المورد.");
      return data[0];
    }),

  confirmPurchase: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), purchaseId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "approvePurchases");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_confirm_purchase", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId,
        p_user_id: ctx.user.id, p_purchase_id: input.purchaseId,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر اعتماد فاتورة المشتريات.");
      return data[0];
    }),

  recordSupplierPayment: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      purchaseId: z.number().int().positive(),
      companyAccountId: z.number().int().positive(),
      amount: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, "يجب ألا يزيد مبلغ الدفعة عن منزلتين عشريتين."),
      paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      operationKey: z.string().trim().min(1).max(180),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_record_supplier_payment", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_purchase_id: input.purchaseId,
        p_company_account_id: input.companyAccountId,
        p_amount: input.amount,
        p_payment_date: input.paymentDate || null,
        p_reference_no: input.referenceNo || null,
        p_notes: input.notes || null,
        p_operation_key: input.operationKey,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تسجيل دفعة المورد.");
      return data[0];
    }),

  returnToSupplier: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      purchaseId: z.number().int().positive(),
      returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      operationKey: z.string().trim().min(1).max(120),
      reason: z.string().trim().min(3).max(500),
      notes: z.string().trim().max(2000).optional(),
      refundAmount: z.number().finite().min(0).max(1_000_000_000)
        .refine((amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-7, {
          message: "مبلغ الاسترداد النقدي يجب أن يكون بحد أقصى منزلتين عشريتين.",
        })
        .default(0),
      refundCompanyAccountId: z.number().int().positive().optional(),
      lines: z.array(z.object({
        purchaseLineId: z.number().int().positive(),
        quantity: z.number().finite().positive().max(1_000_000_000),
      })).min(1).max(200),
    }).superRefine((value, ctx) => {
      if (value.refundAmount > 0 && !value.refundCompanyAccountId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refundCompanyAccountId"], message: "حدد حساب الشركة لاستلام المبلغ النقدي." });
      }
      if (value.refundAmount === 0 && value.refundCompanyAccountId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refundCompanyAccountId"], message: "لا حاجة لحساب شركة إذا لم يُسترد مبلغ نقدي." });
      }
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "adjustInventory");
      if (input.refundAmount > 0) {
        const financialAccess = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments");
        if (financialAccess.tenantId !== access.tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "حساب الشركة غير متاح لهذا المستأجر." });
        }
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_return_to_supplier", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_purchase_id: input.purchaseId, p_return_date: input.returnDate || null,
        p_operation_key: input.operationKey, p_reason: input.reason,
        p_notes: input.notes || null,
        p_lines: input.lines.map((line) => ({ purchase_line_id: line.purchaseLineId, quantity: line.quantity })),
        p_refund_amount: input.refundAmount, p_refund_company_account_id: input.refundCompanyAccountId ?? null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تسجيل مرتجع المورد.");
      return data[0];
    }),


  transferStock: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      itemId: z.number().int().positive(),
      sourceWarehouseId: z.number().int().positive(),
      destinationWarehouseId: z.number().int().positive(),
      quantity: z.number().finite().positive().max(1_000_000_000)
        .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "الكمية تقبل ثلاث منازل عشرية كحد أقصى."),
      operationKey: z.string().trim().min(1).max(170),
      referenceNo: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
    }).refine((value) => value.sourceWarehouseId !== value.destinationWarehouseId, {
      message: "اختر مخزنين مختلفين.", path: ["destinationWarehouseId"],
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "adjustInventory");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_transfer_stock", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_item_id: input.itemId,
        p_source_warehouse_id: input.sourceWarehouseId,
        p_destination_warehouse_id: input.destinationWarehouseId,
        p_quantity: input.quantity,
        p_operation_key: input.operationKey,
        p_reference_no: input.referenceNo || null,
        p_notes: input.notes || null,
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تنفيذ التحويل المخزني.");
      return data[0];
    }),

  receivePurchase: protectedProcedure
    .input(z.object({
      siteId: z.number().int().positive(),
      purchaseId: z.number().int().positive(),
      receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      operationKey: z.string().trim().min(1).max(180),
      notes: z.string().trim().max(2000).optional(),
      lines: z.array(z.object({
        purchaseLineId: z.number().int().positive(),
        quantity: z.number().finite().positive().max(1_000_000_000),
      })).min(1).max(200),
    }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "receiveInventory");
      const { data, error } = await supabaseAdmin().rpc("powerhub_inventory_receive_purchase", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_purchase_id: input.purchaseId, p_receipt_date: input.receiptDate || null,
        p_operation_key: input.operationKey, p_notes: input.notes || null,
        p_lines: input.lines.map((line) => ({ purchase_line_id: line.purchaseLineId, quantity: line.quantity })),
      });
      if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر تسجيل استلام المشتريات.");
      return data[0];
    }),

});
