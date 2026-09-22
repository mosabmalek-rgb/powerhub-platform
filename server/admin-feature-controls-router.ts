import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { authenticatedProcedure } from "./_core/trpc";

const platformAdminProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin" || ctx.user.accountStatus !== "active" || !["platform_owner","platform_admin"].includes(ctx.user.platformRole ?? "")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
  }
  return next({ ctx });
});

const featureKeySchema = z.string().trim().min(2).max(100);
const statusSchema = z.enum(["inherit","enabled","disabled"]);
const limitModeSchema = z.enum(["inherit","manual","unlimited"]);

async function tenantFeatureSnapshot(tenantId: number) {
  const admin = supabaseAdmin();
  const [tenantResult, ownerResult, subscriptionResult, sitesResult, subscribersResult, membersResult, controlsResult, policiesResult] = await Promise.all([
    admin.from("tenants").select("id,name,status,slug").eq("id",tenantId).maybeSingle(),
    admin.from("tenant_owner_profiles").select("tenant_id,owner_user_id,full_name,phone,email,company_name").eq("tenant_id",tenantId).maybeSingle(),
    admin.from("tenant_subscriptions").select("id,package_code,status,started_at,ends_at,billing_cycle").eq("tenant_id",tenantId).in("status",["trial","active"]).order("created_at",{ascending:false}).limit(1).maybeSingle(),
    admin.from("sites").select("id,status",{count:"exact",head:true}).eq("tenant_id",tenantId),
    admin.from("subscribers").select("id",{count:"exact",head:true}).eq("tenant_id",tenantId),
    admin.from("tenant_members").select("user_id,role,is_active,membership_status").eq("tenant_id",tenantId),
    admin.rpc("powerhub_admin_tenant_feature_controls",{p_tenant_id:tenantId}),
    admin.from("package_feature_policies").select("package_code,feature_key,policy,default_limit,limit_mode").order("feature_key"),
  ]);
  const errors = [tenantResult.error,ownerResult.error,subscriptionResult.error,sitesResult.error,subscribersResult.error,membersResult.error,controlsResult.error,policiesResult.error].filter(Boolean);
  if (errors.length) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل مصفوفة ميزات صاحب المولد."});
  const subscription = subscriptionResult.data;
  const packagePolicies = (policiesResult.data ?? []).filter((row:any)=>row.package_code === subscription?.package_code);
  const controls = controlsResult.data ?? [];
  const members = membersResult.data ?? [];
  return {
    tenant: tenantResult.data ? { id:Number(tenantResult.data.id), name:tenantResult.data.name, slug:tenantResult.data.slug, status:tenantResult.data.status } : null,
    owner: ownerResult.data ? { fullName:ownerResult.data.full_name, phone:ownerResult.data.phone, email:ownerResult.data.email, companyName:ownerResult.data.company_name, userId:ownerResult.data.owner_user_id ? Number(ownerResult.data.owner_user_id) : null } : null,
    subscription: subscription ? { id:Number(subscription.id), packageCode:subscription.package_code, status:subscription.status, startedAt:subscription.started_at, endsAt:subscription.ends_at, billingCycle:subscription.billing_cycle } : null,
    usage: {
      subscribers: Number(subscribersResult.count ?? 0),
      branches: Number(sitesResult.count ?? 0),
      platformUsers: members.filter((m:any)=>m.is_active && m.membership_status === "active" && m.role !== "owner").length,
      fieldUsers: members.filter((m:any)=>m.is_active && m.membership_status === "active" && m.role === "technician").length,
    },
    controls: controls.map((row:any)=>({tenantId:Number(row.tenant_id),featureKey:row.feature_key,status:row.status,limitMode:row.limit_mode,manualLimit:row.manual_limit == null ? null : Number(row.manual_limit),overrideReason:row.override_reason,updatedByUserId:row.updated_by_user_id == null ? null : Number(row.updated_by_user_id),updatedAt:row.updated_at})),
    packagePolicies: packagePolicies.map((row:any)=>({featureKey:row.feature_key,policy:row.policy,defaultLimit:row.default_limit == null ? null : Number(row.default_limit),limitMode:row.limit_mode})),
  };
}

export const adminFeatureControlsRouter = router({
  featureCatalog: platformAdminProcedure.query(async () => {
    const {data,error}=await supabaseAdmin().rpc("powerhub_admin_feature_catalog");
    if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل كتالوج الميزات."});
    return (data ?? []).map((row:any)=>({...row}));
  }),

  tenantFeatureSnapshot: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive()})).query(async ({input}) => tenantFeatureSnapshot(input.tenantId)),

  setTenantFeatureControl: platformAdminProcedure.input(z.object({
    tenantId:z.number().int().positive(),
    featureKey:featureKeySchema,
    status:statusSchema,
    limitMode:limitModeSchema,
    manualLimit:z.number().int().min(0).max(100000000).nullable().optional(),
    reason:z.string().trim().max(2000).optional(),
  })).mutation(async ({ctx,input}) => {
    const {data,error}=await supabaseAdmin().rpc("powerhub_admin_set_tenant_feature_control",{
      p_actor_user_id:ctx.user.id,
      p_tenant_id:input.tenantId,
      p_feature_key:input.featureKey,
      p_status:input.status,
      p_limit_mode:input.limitMode,
      p_manual_limit:input.limitMode === "manual" ? (input.manualLimit ?? null) : null,
      p_reason:input.reason ?? null,
    });
    if(error){
      const message=String(error.message ?? "");
      if(message.includes("FEATURE_NOT_AVAILABLE_IN_PACKAGE")) throw new TRPCError({code:"PRECONDITION_FAILED",message:"لا يمكن تفعيل هذه الميزة لأن الباقة الحالية لا تتيحها."});
      if(message.includes("TENANT_NOT_FOUND")) throw new TRPCError({code:"NOT_FOUND",message:"صاحب المولد غير موجود."});
      if(message.includes("FEATURE_NOT_FOUND")) throw new TRPCError({code:"NOT_FOUND",message:"الميزة غير موجودة في كتالوج المنصة."});
      throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر حفظ إعداد الميزة."});
    }
    return data?.[0] ? {
      tenantId:Number(data[0].tenant_id),
      featureKey:data[0].feature_key,
      status:data[0].status,
      limitMode:data[0].limit_mode,
      manualLimit:data[0].manual_limit == null ? null : Number(data[0].manual_limit),
      overrideReason:data[0].override_reason,
      updatedAt:data[0].updated_at,
    } : null;
  }),

  resetTenantFeatureControl: platformAdminProcedure.input(z.object({
    tenantId:z.number().int().positive(),
    featureKey:featureKeySchema,
    reason:z.string().trim().max(2000).optional(),
  })).mutation(async ({ctx,input}) => {
    const {data,error}=await supabaseAdmin().rpc("powerhub_admin_reset_tenant_feature_control",{
      p_actor_user_id:ctx.user.id,
      p_tenant_id:input.tenantId,
      p_feature_key:input.featureKey,
      p_reason:input.reason ?? null,
    });
    if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر إعادة الميزة إلى إعدادات الباقة."});
    return {success:Boolean(data)};
  }),
});
