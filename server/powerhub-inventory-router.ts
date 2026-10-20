import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireSupabaseSiteRole } from "./powerhub-supabase";
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

async function writeInventoryAudit(input: {
  tenantId: number;
  siteId: number;
  userId: number;
  entityType: "inventory_item" | "supplier" | "inventory_warehouse";
  entityId: number;
  action: "create";
  afterData: Record<string, unknown>;
  table: "inventory_items" | "suppliers" | "inventory_warehouses";
}) {
  const admin = supabaseAdmin();
  const { error } = await admin.from("audit_logs").insert({
    tenant_id: input.tenantId,
    site_id: input.siteId,
    user_id: input.userId,
    entity_type: input.entityType,
    entity_id: String(input.entityId),
    action: input.action,
    after_data: input.afterData,
  });
  if (!error) return;

  // Do not report a successful create when its audit trail was not written.
  // These new records have not yet been exposed to any dependent workflow.
  await admin.from(input.table).delete().eq("tenant_id", input.tenantId).eq("id", input.entityId);
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل العملية في سجل التدقيق؛ لم تُعتمد الإضافة." });
}

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
      if (input.search) query = query.or(`name.ilike.%${input.search}%,sku.ilike.%${input.search}%`);
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
      const admin = supabaseAdmin();
      const { data, error } = await admin.from("inventory_items").insert({
        tenant_id: access.tenantId,
        sku: input.sku || null,
        name: input.name,
        category: input.category,
        base_unit: input.baseUnit,
        reorder_point: input.reorderPoint,
        specification: input.specification || null,
        notes: input.notes || null,
        created_by_user_id: ctx.user.id,
      }).select("id,tenant_id,sku,name,category,base_unit,reorder_point,specification,notes,is_active,created_at,updated_at").single();
      if (error || !data) mapDatabaseError(error, "تعذر إضافة الصنف إلى الدليل الموحد.");
      await writeInventoryAudit({
        tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id,
        entityType: "inventory_item", entityId: Number(data.id), action: "create",
        afterData: { sku: data.sku, name: data.name, category: data.category, baseUnit: data.base_unit },
        table: "inventory_items",
      });
      return data;
    }),

  listSuppliers: protectedProcedure
    .input(z.object({ siteId: z.number().int().positive(), search: z.string().trim().max(100).optional(), includeInactive: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewSupplierLedger");
      let query = supabaseAdmin().from("suppliers")
        .select("id,tenant_id,supplier_code,name,contact_name,phone,email,address,tax_number,default_payment_terms_days,notes,is_active,created_at,updated_at")
        .eq("tenant_id", access.tenantId)
        .order("name", { ascending: true })
        .limit(500);
      if (!input.includeInactive) query = query.eq("is_active", true);
      if (input.search) query = query.or(`name.ilike.%${input.search}%,supplier_code.ilike.%${input.search}%,phone.ilike.%${input.search}%`);
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
      const { data, error } = await supabaseAdmin().from("suppliers").insert({
        tenant_id: access.tenantId,
        supplier_code: input.supplierCode || null,
        name: input.name,
        contact_name: input.contactName || null,
        phone: input.phone || null,
        email: input.email || null,
        address: input.address || null,
        tax_number: input.taxNumber || null,
        default_payment_terms_days: input.defaultPaymentTermsDays,
        notes: input.notes || null,
        created_by_user_id: ctx.user.id,
      }).select("id,tenant_id,supplier_code,name,contact_name,phone,email,address,tax_number,default_payment_terms_days,notes,is_active,created_at,updated_at").single();
      if (error || !data) mapDatabaseError(error, "تعذر إضافة المورد.");
      await writeInventoryAudit({
        tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id,
        entityType: "supplier", entityId: Number(data.id), action: "create",
        afterData: { supplierCode: data.supplier_code, name: data.name, phone: data.phone },
        table: "suppliers",
      });
      return data;
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
      const { data, error } = await supabaseAdmin().from("inventory_warehouses").insert({
        tenant_id: access.tenantId,
        site_id: input.siteId,
        code: input.code,
        name: input.name,
        notes: input.notes || null,
        created_by_user_id: ctx.user.id,
      }).select("id,tenant_id,site_id,code,name,notes,is_active,created_at,updated_at").single();
      if (error || !data) mapDatabaseError(error, "تعذر إنشاء المخزن.");
      await writeInventoryAudit({
        tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id,
        entityType: "inventory_warehouse", entityId: Number(data.id), action: "create",
        afterData: { code: data.code, name: data.name },
        table: "inventory_warehouses",
      });
      return data;
    }),
});
