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
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewSupplierLedger");
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
});
      return data;
    }),
});
