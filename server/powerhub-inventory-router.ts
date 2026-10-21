import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireSupabaseSiteRole, resolveSupabaseSiteAccess } from "./powerhub-supabase";
import { supabaseAdmin } from "./supabase-admin";

const roles = ["owner", "manager", "accountant", "collector", "technician", "viewer"] as const;
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
  const known: Record<string, { code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND"; message: string }> = {
    INVALID_OPERATION_KEY: { code: "BAD_REQUEST", message: "مفتاح العملية غير صالح." },
    INVALID_PURCHASE_LINES: { code: "BAD_REQUEST", message: "تحقق من بنود فاتورة المشتريات والكميات والأسعار." },
    INVALID_RECEIPT_LINES: { code: "BAD_REQUEST", message: "تحقق من كميات الاستلام." },
    INVALID_PAYMENT_TERMS: { code: "BAD_REQUEST", message: "مدة السداد غير صالحة." },
    INVALID_DUE_DATE: { code: "BAD_REQUEST", message: "تاريخ الاستحقاق لا يجوز أن يسبق تاريخ الفاتورة." },
    PURCHASE_NOT_FOUND: { code: "NOT_FOUND", message: "فاتورة المشتريات غير موجودة في هذا الفرع." },
    PURCHASE_LINE_NOT_FOUND: { code: "NOT_FOUND", message: "أحد بنود المشتريات غير موجود." },
    SUPPLIER_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المورد غير نشط أو لا ينتمي إلى الشركة." },
    WAREHOUSE_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "المخزن غير نشط أو لا يتبع هذا الفرع." },
    ITEM_OUT_OF_SCOPE: { code: "BAD_REQUEST", message: "أحد الأصناف غير نشط أو لا ينتمي إلى الشركة." },
    OVER_RECEIPT: { code: "CONFLICT", message: "كمية الاستلام تتجاوز الكمية المتبقية في الفاتورة." },
    PURCHASE_NOT_RECEIVABLE: { code: "CONFLICT", message: "لا يمكن استلام هذه الفاتورة قبل اعتمادها أو بعد اكتمالها." },
    PURCHASE_STATE_CONFLICT: { code: "CONFLICT", message: "حالة فاتورة المشتريات لا تسمح بهذه العملية." },
    IDEMPOTENCY_KEY_REUSED: { code: "CONFLICT", message: "مفتاح العملية مستخدم بطلب مختلف؛ أنشئ مفتاحًا جديدًا." },
    DUPLICATE_PURCHASE_LINE: { code: "BAD_REQUEST", message: "لا تكرر بند الفاتورة نفسه ضمن طلب الاستلام الواحد." },
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
  const canViewFinancials = access.permissions.includes("viewPurchases");
  if (!canViewFinancials && !access.permissions.includes("receiveInventory")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "ليست لديك صلاحية عرض المشتريات أو الاستلام." });
  }
  return { ...access, canViewFinancials };
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
      const [lineResult, receiptResult, supplierResult, warehouseResult] = await Promise.all([
        supabaseAdmin().from("supplier_purchase_lines")
          .select("id,tenant_id,purchase_id,item_id,quantity,unit,units_to_base_factor,unit_price,discount_amount,tax_amount,line_subtotal,line_total,received_quantity,notes,created_at,updated_at")
          .eq("tenant_id", access.tenantId).eq("purchase_id", input.purchaseId).order("id", { ascending: true }),
        supabaseAdmin().from("supplier_purchase_receipts")
          .select("id,receipt_number,receipt_date,operation_key,notes,received_at,received_by_user_id,created_at")
          .eq("tenant_id", access.tenantId).eq("purchase_id", input.purchaseId).order("id", { ascending: false }).limit(100),
        supabaseAdmin().from("suppliers").select("id,name,supplier_code")
          .eq("tenant_id", access.tenantId).eq("id", purchase.supplier_id).maybeSingle(),
        supabaseAdmin().from("inventory_warehouses").select("id,name,code")
          .eq("tenant_id", access.tenantId).eq("id", purchase.warehouse_id).maybeSingle(),
      ]);
      if (lineResult.error || receiptResult.error || supplierResult.error || warehouseResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل البنود والاستلام." });
      }
      const itemIds = [...new Set((lineResult.data ?? []).map((line) => Number(line.item_id)))];
      const itemResult = itemIds.length
        ? await supabaseAdmin().from("inventory_items").select("id,name,sku,base_unit").eq("tenant_id", access.tenantId).in("id", itemIds)
        : { data: [], error: null };
      if (itemResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء الأصناف." });
      const items = new Map((itemResult.data ?? []).map((item) => [Number(item.id), item]));
      return {
        purchase: {
          ...purchase,
          supplierName: supplierResult.data?.name ?? "مورد غير متاح",
          supplierCode: supplierResult.data?.supplier_code ?? null,
          warehouseName: warehouseResult.data?.name ?? "مخزن غير متاح",
          canViewFinancials: access.canViewFinancials,
          ...(access.canViewFinancials ? {} : {
            supplier_invoice_no: null, due_date: null, subtotal_amount: null, discount_amount: null,
            tax_amount: null, other_charges_amount: null, total_amount: null, payment_terms_days: null,
            reference_no: null, notes: null,
          }),
        },
        canViewFinancials: access.canViewFinancials,
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
