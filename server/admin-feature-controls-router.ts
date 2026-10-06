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
    admin.from("tenants").select("id,name,status,slug,created_at").eq("id",tenantId).maybeSingle(),
    admin.from("tenant_owner_profiles").select("tenant_id,owner_user_id,full_name,phone,email,company_name").eq("tenant_id",tenantId).maybeSingle(),
    admin.from("tenant_subscriptions").select("id,package_code,status,started_at,ends_at,billing_cycle").eq("tenant_id",tenantId).order("created_at",{ascending:false}).limit(1).maybeSingle(),
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
    subscription: subscription ? { id:Number(subscription.id), packageCode:subscription.package_code, status:subscription.status, startedAt:subscription.started_at, endsAt:subscription.ends_at, billingCycle:subscription.billing_cycle, isEffectivelyActive: ["trial","active"].includes(String(subscription.status)) && (!subscription.ends_at || new Date(subscription.ends_at).getTime() > Date.now()) } : null,
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
  setGlobalFeature: platformAdminProcedure.input(z.object({ featureKey: featureKeySchema, isActive: z.boolean() })).mutation(async ({ctx,input}) => {
    const {data,error}=await supabaseAdmin().rpc("powerhub_admin_set_feature_global",{p_actor_user_id:ctx.user.id,p_feature_key:input.featureKey,p_is_active:input.isActive});
    if(error){const message=String(error.message ?? "");if(message.includes("FEATURE_NOT_FOUND")) throw new TRPCError({code:"NOT_FOUND",message:"الميزة غير موجودة."});throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحديث إتاحة الميزة على مستوى المنصة."});}
    return data?.[0] ?? null;
  }),

  featureCatalog: platformAdminProcedure.query(async () => {
    const {data,error}=await supabaseAdmin().rpc("powerhub_admin_feature_catalog");
    if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل كتالوج الميزات."});
    return (data ?? []).map((row:any)=>({...row}));
  }),

  tenantFeatureMatrix: platformAdminProcedure.query(async () => {
    const admin = supabaseAdmin();
    const [tenantsResult, ownersResult, subscriptionsResult, sitesResult, membersResult, subscribersResult] = await Promise.all([
      // Production schema does not have the legacy plan/package_code columns on tenants.
      // Subscription is the source of truth for the current package.
      admin.from("tenants").select("id,name,status,slug,created_at").order("name", { ascending: true }).limit(500),
      admin.from("tenant_owner_profiles").select("tenant_id,full_name,company_name").limit(500),
      admin.from("tenant_subscriptions").select("tenant_id,package_code,status,ends_at").order("created_at", { ascending: false }).limit(1000),
      admin.from("sites").select("id,tenant_id,status").limit(5000),
      admin.from("tenant_members").select("tenant_id,user_id,role,is_active,membership_status").limit(5000),
      admin.from("subscribers").select("tenant_id").limit(10000),
    ]);
    if (tenantsResult.error || ownersResult.error || subscriptionsResult.error || sitesResult.error || membersResult.error || subscribersResult.error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مصفوفة أصحاب المولدات." });
    }

    const owners = new Map((ownersResult.data ?? []).map((row) => [Number(row.tenant_id), row]));
    const subscriptions = new Map<number, any>();
    for (const row of subscriptionsResult.data ?? []) {
      const tenantId = Number(row.tenant_id);
      if (!subscriptions.has(tenantId)) subscriptions.set(tenantId, row);
    }
    const branches = new Map<number, number>();
    for (const row of sitesResult.data ?? []) {
      if (row.status === "archived") continue;
      const tenantId = Number(row.tenant_id);
      branches.set(tenantId, (branches.get(tenantId) ?? 0) + 1);
    }
    const subscribers = new Map<number, number>();
    for (const row of subscribersResult.data ?? []) {
      const tenantId = Number(row.tenant_id);
      subscribers.set(tenantId, (subscribers.get(tenantId) ?? 0) + 1);
    }
    const users = new Map<number, { platform: number; field: number }>();
    for (const row of membersResult.data ?? []) {
      if (!row.is_active || row.membership_status !== "active" || row.role === "owner") continue;
      const tenantId = Number(row.tenant_id);
      const current = users.get(tenantId) ?? { platform: 0, field: 0 };
      current.platform += 1;
      if (row.role === "technician") current.field += 1;
      users.set(tenantId, current);
    }
    return (tenantsResult.data ?? []).map((tenant) => {
      const tenantId = Number(tenant.id);
      const subscription = subscriptions.get(tenantId);
      const usage = users.get(tenantId) ?? { platform: 0, field: 0 };
      return {
        tenant: { id: tenantId, name: tenant.name, status: tenant.status, slug: tenant.slug },
        owner: owners.get(tenantId) ? { fullName: owners.get(tenantId)?.full_name ?? null, companyName: owners.get(tenantId)?.company_name ?? null } : null,
        subscription: subscription ? { packageCode: subscription.package_code, status: subscription.status, endsAt: subscription.ends_at } : null,
        usage: { subscribers: subscribers.get(tenantId) ?? 0, branches: branches.get(tenantId) ?? 0, platformUsers: usage.platform, fieldUsers: usage.field },
      };
    });
  }),

  tenantFeatureSnapshot: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive()})).query(async ({input}) => tenantFeatureSnapshot(input.tenantId)),

  setTenantFeatureControl: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),featureKey:featureKeySchema,status:statusSchema,limitMode:limitModeSchema,manualLimit:z.number().int().min(0).max(100000000).nullable().optional(),reason:z.string().trim().max(2000).optional()})).mutation(async ({ctx,input}) => {
    const {data,error}=await supabaseAdmin().rpc("powerhub_admin_set_tenant_feature_control",{p_actor_user_id:ctx.user.id,p_tenant_id:input.tenantId,p_feature_key:input.featureKey,p_status:input.status,p_limit_mode:input.limitMode,p_manual_limit:input.limitMode === "manual" ? (input.manualLimit ?? null) : null,p_reason:input.reason ?? null});
    if(error){const message=String(error.message ?? "");if(message.includes("FEATURE_NOT_AVAILABLE_IN_PACKAGE")) throw new TRPCError({code:"PRECONDITION_FAILED",message:"لا يمكن تفعيل هذه الميزة لأن الباقة الحالية لا تتيحها."});if(message.includes("TENANT_NOT_FOUND")) throw new TRPCError({code:"NOT_FOUND",message:"صاحب المولد غير موجود."});if(message.includes("FEATURE_NOT_FOUND")) throw new TRPCError({code:"NOT_FOUND",message:"الميزة غير موجودة في كتالوج المنصة."});if(message.includes("FEATURE_NOT_TENANT_CONTROLLABLE")) throw new TRPCError({code:"PRECONDITION_FAILED",message:"هذه ميزة عامة على مستوى المنصة ولا تُدار لكل صاحب مولد من هذه الشاشة."});throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر حفظ إعداد الميزة."});}
    return data?.[0] ? {tenantId:Number(data[0].tenant_id),featureKey:data[0].feature_key,status:data[0].status,limitMode:data[0].limit_mode,manualLimit:data[0].manual_limit == null ? null : Number(data[0].manual_limit),overrideReason:data[0].override_reason,updatedAt:data[0].updated_at} : null;
  }),

  ownerQuotaUsageReport: platformAdminProcedure.query(async () => {
    const admin = supabaseAdmin();
    const [tenantsResult, ownersResult, subscriptionsResult, sitesResult, membersResult, subscribersResult, smsAccountsResult, smsUsageResult, addonsResult, catalogResult] = await Promise.all([
      admin.from("tenants").select("id,name,status,slug").order("name", { ascending: true }).limit(500),
      admin.from("tenant_owner_profiles").select("tenant_id,full_name,company_name").limit(500),
      admin.from("tenant_subscriptions").select("tenant_id,package_code,status,started_at,ends_at,billing_cycle,archived_at").order("created_at", { ascending: false }).limit(1000),
      admin.from("sites").select("id,tenant_id,status").limit(5000),
      admin.from("tenant_members").select("tenant_id,user_id,role,is_active,membership_status").limit(10000),
      admin.from("subscribers").select("tenant_id").limit(20000),
      admin.from("tenant_tweetsms_accounts").select("tenant_id,monthly_limit,is_active,credential_ciphertext").limit(500),
      admin.from("notification_messages").select("tenant_id,segment_count,status,created_at").eq("channel","sms").gte("created_at", new Date(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1).toISOString()).in("status",["processing","submitted","delivered","read"]).limit(100000),
      admin.from("tenant_addon_requests").select("id,tenant_id,addon_code,quantity,status,duration_days,starts_at,ends_at").eq("status","approved").limit(5000),
      admin.from("platform_settings").select("value").eq("setting_key","subscription_package_catalog").maybeSingle(),
    ]);
    const errors=[tenantsResult.error,ownersResult.error,subscriptionsResult.error,membersResult.error,subscribersResult.error,smsAccountsResult.error,smsUsageResult.error,addonsResult.error,catalogResult.error].filter(Boolean);
    if(errors.length) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل تقرير حدود واستهلاك أصحاب المولدات."});
    const tenants=tenantsResult.data??[];
    const owners=new Map((ownersResult.data??[]).map(r=>[Number(r.tenant_id),r]));
    const subscriptions=new Map<number,any>();
    for(const row of subscriptionsResult.data??[]){const id=Number(row.tenant_id);if(!subscriptions.has(id))subscriptions.set(id,row);}
    const branches=new Map<number,number>(); for(const row of sitesResult.data??[]){if(row.status==="archived")continue;const id=Number(row.tenant_id);branches.set(id,(branches.get(id)??0)+1);}
    const subscribers=new Map<number,number>(); for(const row of subscribersResult.data??[]){const id=Number(row.tenant_id);subscribers.set(id,(subscribers.get(id)??0)+1);}
    const members=new Map<number,{platform:number;field:number}>(); for(const row of membersResult.data??[]){if(!row.is_active||row.membership_status!=="active"||row.role==="owner")continue;const id=Number(row.tenant_id);const v=members.get(id)??{platform:0,field:0};if(row.role==="technician")v.field+=1;else v.platform+=1;members.set(id,v);}
    const smsAccounts=new Map((smsAccountsResult.data??[]).map(r=>[Number(r.tenant_id),r]));
    const smsUsed=new Map<number,number>(); for(const row of smsUsageResult.data??[]){const id=Number(row.tenant_id);smsUsed.set(id,(smsUsed.get(id)??0)+Math.max(1,Number(row.segment_count??1)));}
    const addons=new Map<number,any[]>(); for(const row of addonsResult.data??[]){const id=Number(row.tenant_id);const active=!row.starts_at||new Date(row.starts_at)<=new Date();const unexpired=!row.ends_at||new Date(row.ends_at)>new Date();if(active&&unexpired)(addons.get(id)??addons.set(id,[]).get(id)!).push(row);}
    const catalog=(catalogResult.data?.value&&typeof catalogResult.data.value==="object"&&!Array.isArray(catalogResult.data.value)?catalogResult.data.value as Record<string,unknown>:{});
    const packages=Array.isArray(catalog.packages)?catalog.packages as Array<Record<string,any>>:[];
    const pkgMap=new Map(packages.map(p=>[String(p.code),p]));
    const quota=async (tenantId:number,resource:"subscribers"|"platformUser"|"fieldUser"|"branch"|"sms")=>{const {data,error}=await admin.rpc("powerhub_effective_tenant_quota",{p_tenant_id:tenantId,p_resource:resource});if(error)throw error;return Number(Array.isArray(data)?data[0]:data??0);};
    const rows=[];
    for(const tenant of tenants){
      const id=Number(tenant.id); const sub=subscriptions.get(id); const pkg=pkgMap.get(String(sub?.package_code)); const u=members.get(id)??{platform:0,field:0}; const sms=smsAccounts.get(id); const a=addons.get(id)??[];
      const [subscriberLimit,branchLimit,platformLimit,fieldLimit,smsLimit]=await Promise.all([quota(id,"subscribers"),quota(id,"branch"),quota(id,"platformUser"),quota(id,"fieldUser"),quota(id,"sms")]);
      const smsValue=smsUsed.get(id)??0;
      rows.push({tenant:{id,name:tenant.name,status:tenant.status,createdAt:tenant.created_at},owner:owners.get(id)?{fullName:owners.get(id)?.full_name??null,companyName:owners.get(id)?.company_name??null}:null,subscription:sub?{packageCode:sub.package_code,status:sub.status,startedAt:sub.started_at,endsAt:sub.ends_at,billingCycle:sub.billing_cycle,archivedAt:sub.archived_at}:null,package:{name:pkg?.name??sub?.package_code??"—"},usage:{subscribers:subscribers.get(id)??0,branches:branches.get(id)??0,platformUsers:u.platform,fieldUsers:u.field},limits:{subscribers:subscriberLimit,branches:branchLimit,platformUsers:platformLimit,fieldUsers:fieldLimit,messages:smsLimit},messages:{used:smsValue,remaining:Math.max(0,smsLimit-smsValue)},addons:a.map(x=>({id:Number(x.id),code:x.addon_code,quantity:Number(x.quantity),durationDays:x.duration_days,startsAt:x.starts_at,endsAt:x.ends_at})),daysRemaining:sub?.ends_at?Math.max(0,Math.ceil((new Date(sub.ends_at).getTime()-Date.now())/86400000)):null});
    }
    return rows;
  }),
  resetTenantFeatureControl: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),featureKey:featureKeySchema,reason:z.string().trim().max(2000).optional()})).mutation(async ({ctx,input}) => {
    const {data,error}=await supabaseAdmin().rpc("powerhub_admin_reset_tenant_feature_control",{p_actor_user_id:ctx.user.id,p_tenant_id:input.tenantId,p_feature_key:input.featureKey,p_reason:input.reason ?? null});
    if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر إعادة الميزة إلى إعدادات الباقة."});
    return {success:Boolean(data)};
  }),
});
