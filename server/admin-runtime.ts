import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { encryptTenantCredential } from "./tenant-crypto";
import { ownerOverviewFromSupabase, platformSnapshotFromSupabase } from "./admin-supabase";
import { attachOwnerUser as attachOwnerUserSupabase, quickUpgradeOwnerPlan as quickUpgradeOwnerPlanSupabase, renewSubscription as renewSubscriptionSupabase, reviewSmsPackageRequest as reviewSmsPackageRequestSupabase, reviewSubscriptionUpgradeRequest as reviewSubscriptionUpgradeRequestSupabase, setTenantMembershipStatus as setTenantMembershipStatusSupabase, updateSubscription as updateSubscriptionSupabase } from "./admin-supabase-writes";

const planSchema = z.enum(["starter", "professional", "enterprise"]);
const subscriptionStatusSchema = z.enum(["trial", "active", "overdue", "suspended", "cancelled"]);
const billingCycleSchema = z.enum(["monthly", "yearly"]);
type PlatformRole = "platform_owner" | "platform_admin" | "finance_admin";
type AdminRecord = Record<string, any>;

function requirePlatformRoles(allowedRoles: PlatformRole[]) {
  return authenticatedProcedure.use(({ ctx, next }) => {
    const role = (ctx.user.platformRole ?? "platform_admin") as PlatformRole;
    if (ctx.user.role !== "admin" || !allowedRoles.includes(role) || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    return next({ ctx });
  });
}
const platformAdminProcedure = requirePlatformRoles(["platform_owner", "platform_admin"]);
const platformFinanceProcedure = requirePlatformRoles(["platform_owner", "platform_admin", "finance_admin"]);

export function addSubscriptionPeriod(from: Date, cycle: "monthly" | "yearly", units = 1) {
  const result = new Date(from);
  if (cycle === "yearly") result.setFullYear(result.getFullYear() + units); else result.setMonth(result.getMonth() + units);
  return result;
}
export function tenantStatusForSubscription(status: z.infer<typeof subscriptionStatusSchema>) {
  return status === "suspended" || status === "cancelled" ? "suspended" as const : "active" as const;
}
export function platformSmsFallbackProviderSummary(provider: { id:number; name:string; providerKey:string; apiEndpoint:string|null; senderName:string|null; priority:number; integrationStatus:"pending_contract"|"ready"; isActive:boolean; credentialCiphertext:string|null; credentialIv:string|null; lastTestedAt:Date|null; lastError:string|null; updatedAt:Date }) {
  return { id:provider.id, name:provider.name, providerKey:provider.providerKey, apiEndpoint:provider.apiEndpoint, senderName:provider.senderName, priority:provider.priority, integrationStatus:provider.integrationStatus, isActive:provider.isActive, configured:Boolean(provider.credentialCiphertext&&provider.credentialIv), lastTestedAt:provider.lastTestedAt, lastError:provider.lastError, updatedAt:provider.updatedAt };
}
const retiredMutation = (operation: string) => platformAdminProcedure.input(z.any()).mutation(async () => {
  throw new TRPCError({ code:"PRECONDITION_FAILED", message:`${operation} متوقف؛ المسار القديم القائم على MySQL غير قابل للتنفيذ. استخدم المسار Supabase المعتمد.` });
});

export const adminRouter = router({
  createGeneratorOwnerSubscription: platformAdminProcedure.input(z.object({
    companyName:z.string().min(2).max(180), ownerName:z.string().min(2).max(180), identityNumber:z.string().min(4).max(50), ownerPhone:z.string().min(5).max(30), ownerWhatsapp:z.preprocess(v=>typeof v==="string"&&!v.trim()?undefined:v,z.string().min(5).max(30).optional()), ownerEmail:z.string().email(), temporaryPassword:z.string().min(8).max(128), plan:planSchema.default("starter"), trialDurationDays:z.number().int().min(1).max(3650).default(8),
  })).mutation(async ({ctx,input}) => {
    const email=input.ownerEmail.trim().toLowerCase();
    const identity=encryptTenantCredential(input.identityNumber.trim());
    const admin=supabaseAdmin();
    const {data:authData,error:authError}=await admin.auth.admin.createUser({email,password:input.temporaryPassword,email_confirm:true,user_metadata:{name:input.ownerName.trim(),must_change_password:true}});
    if(authError||!authData.user) throw new TRPCError({code:authError?.status===422?"CONFLICT":"BAD_REQUEST",message:authError?.message||"تعذر إنشاء حساب صاحب المولد في Supabase Auth."});
    try {
      const {data,error}=await admin.rpc("powerhub_create_generator_owner_subscription",{p_actor_user_id:ctx.user.id,p_auth_user_id:authData.user.id,p_tenant_name:input.companyName.trim(),p_slug:`owner-${crypto.randomUUID().replaceAll("-","")}`,p_company_name:input.companyName.trim(),p_owner_name:input.ownerName.trim(),p_identity_ciphertext:identity.ciphertext,p_identity_iv:identity.iv,p_identity_last4:input.identityNumber.trim().slice(-4),p_owner_phone:input.ownerPhone.trim(),p_owner_whatsapp:input.ownerWhatsapp?.trim()||null,p_owner_email:email,p_site_name:"الفرع الرئيسي",p_site_code:`SITE-${crypto.randomUUID().slice(0,8).toUpperCase()}`,p_plan:input.plan,p_billing_cycle:"monthly",p_subscription_status:"trial",p_trial_duration_days:input.trialDurationDays});
      if(error||!data?.[0]) throw error??new Error("لم تُرجع معاملة Supabase نتيجة صالحة.");
      return data[0];
    } catch(error) {
      await admin.auth.admin.deleteUser(authData.user.id);
      throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:error instanceof Error?error.message:"تعذر إكمال إنشاء اشتراك صاحب المولد."});
    }
  }),
  overview: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive().optional()}).optional()).query(async ({input}) => { const owners=await ownerOverviewFromSupabase(input?.tenantId); const totals=owners.reduce((a,item)=>({generatorOwners:a.generatorOwners+1,residential:a.residential+item.subscribers.residential,commercial:a.commercial+item.subscribers.commercial,subscribers:a.subscribers+item.subscribers.total,activeSubscriptions:a.activeSubscriptions+(item.subscription?.status==="active"||item.subscription?.status==="trial"?1:0)}),{generatorOwners:0,residential:0,commercial:0,subscribers:0,activeSubscriptions:0}); return {totals,owners}; }),
  listOwners: platformAdminProcedure.query(async ()=>ownerOverviewFromSupabase()),
  platformSnapshot: platformAdminProcedure.query(async ()=>platformSnapshotFromSupabase()),
  listPlatformSmsFallbackProviders: platformAdminProcedure.query(async ()=>{ const {data,error}=await supabaseAdmin().from("platform_sms_fallback_providers").select("id,name,provider_key,api_endpoint,sender_name,priority,integration_status,is_active,credential_ciphertext,credential_iv,last_tested_at,last_error,updated_at").order("priority",{ascending:true}).order("updated_at",{ascending:false}); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل مزودي الرسائل الاحتياطيين من Supabase."}); return (data??[]).map(p=>platformSmsFallbackProviderSummary({id:Number(p.id),name:p.name,providerKey:p.provider_key,apiEndpoint:p.api_endpoint,senderName:p.sender_name,priority:Number(p.priority),integrationStatus:p.integration_status as "pending_contract"|"ready",isActive:p.is_active,credentialCiphertext:p.credential_ciphertext,credentialIv:p.credential_iv,lastTestedAt:p.last_tested_at?new Date(p.last_tested_at):null,lastError:p.last_error,updatedAt:new Date(p.updated_at)})); }),
  getPlatformTweetSmsAccount: platformAdminProcedure.query(async ()=>{ const {data,error}=await supabaseAdmin().from("platform_tweetsms_accounts").select("id,api_endpoint,sender_name,low_balance_threshold,last_provider_balance,last_balance_checked_at,last_tested_at,last_error,is_active,credential_ciphertext,credential_iv").order("updated_at",{ascending:false}).limit(1).maybeSingle(); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل إعدادات مزود الرسائل المركزي من Supabase."}); if(!data) return null; return {id:Number(data.id),apiEndpoint:data.api_endpoint,senderName:data.sender_name,lowBalanceThreshold:Number(data.low_balance_threshold),lastProviderBalance:data.last_provider_balance,lastBalanceCheckedAt:data.last_balance_checked_at,lastTestedAt:data.last_tested_at,lastError:data.last_error,isActive:data.is_active,configured:Boolean(data.credential_ciphertext&&data.credential_iv)}; }),
  listTweetSmsAccounts: platformAdminProcedure.query(async ()=>{ const {data,error}=await supabaseAdmin().from("tenant_tweetsms_accounts").select("id,tenant_id,api_endpoint,sender_name,monthly_limit,is_active,last_tested_at,last_error,updated_at").order("updated_at",{ascending:false}).limit(500); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل حسابات TweetSMS من Supabase."}); return (data??[]).map(r=>({id:Number(r.id),tenantId:Number(r.tenant_id),apiEndpoint:r.api_endpoint,senderName:r.sender_name,monthlyLimit:Number(r.monthly_limit),usedThisMonth:0,remaining:Number(r.monthly_limit),isActive:r.is_active,configured:Boolean(r.api_endpoint),lastTestedAt:r.last_tested_at,lastError:r.last_error,updatedAt:r.updated_at})); }),
  listSubscriptionUpgradeRequests: platformAdminProcedure.query(async (): Promise<AdminRecord[]>=>{ const {data,error}=await supabaseAdmin().from("subscription_upgrade_requests").select("id,tenant_id,current_plan,requested_plan,status,note,created_at,reviewed_at").order("created_at",{ascending:false}).limit(300); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل طلبات ترقية الباقات من Supabase."}); return (data??[]).map(r=>({id:Number(r.id),tenantId:Number(r.tenant_id),currentPlan:r.current_plan,requestedPlan:r.requested_plan,status:r.status,note:r.note,createdAt:r.created_at,reviewedAt:r.reviewed_at,tenantName:"—",ownerName:"—",ownerEmail:null})); }),
  reviewSubscriptionUpgradeRequest: platformAdminProcedure.input(z.object({id:z.number().int().positive(),decision:z.enum(["approved","rejected"]),note:z.string().trim().max(1000).optional()})).mutation(async ({ctx,input})=>reviewSubscriptionUpgradeRequestSupabase({actorUserId:ctx.user.id,requestId:input.id,decision:input.decision,note:input.note})),
  quickUpgradeOwnerPlan: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),plan:planSchema,note:z.string().trim().max(1000).optional()})).mutation(async ({ctx,input})=>quickUpgradeOwnerPlanSupabase({actorUserId:ctx.user.id,tenantId:input.tenantId,plan:input.plan,note:input.note??""})),
  setTenantMembershipStatus: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),userId:z.number().int().positive(),status:z.enum(["active","suspended","revoked"])})).mutation(async ({ctx,input})=>setTenantMembershipStatusSupabase({actorUserId:ctx.user.id,tenantId:input.tenantId,userId:input.userId,status:input.status})),
  attachOwnerUser: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),userId:z.number().int().positive(),siteId:z.number().int().positive().optional()})).mutation(async ({ctx,input})=>attachOwnerUserSupabase({actorUserId:ctx.user.id,tenantId:input.tenantId,userId:input.userId,siteId:input.siteId})),
  updateSubscription: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),plan:planSchema,status:subscriptionStatusSchema,billingCycle:billingCycleSchema,endsAt:z.date(),autoRenew:z.boolean(),notes:z.string().max(2000).optional(),smsPlanId:z.number().int().positive().nullable().optional()})).mutation(async ({ctx,input})=>updateSubscriptionSupabase({actorUserId:ctx.user.id,tenantId:input.tenantId,plan:input.plan,status:input.status,billingCycle:input.billingCycle,endsAt:input.endsAt,autoRenew:input.autoRenew,notes:input.notes,smsPlanId:input.smsPlanId})),
  renewSubscription: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),periods:z.number().int().min(1).max(24).default(1)})).mutation(async ({ctx,input})=>renewSubscriptionSupabase({actorUserId:ctx.user.id,tenantId:input.tenantId,periods:input.periods})),
  listSmsPlans: platformAdminProcedure.query(async ()=>{ const {data,error}=await supabaseAdmin().from("platform_sms_plans").select("id,code,name,description,included_messages,is_active,created_at,updated_at").order("created_at",{ascending:false}); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل باقات الرسائل من Supabase."}); return (data??[]).map(r=>({id:Number(r.id),code:r.code,name:r.name,description:r.description,includedMessages:r.included_messages,isActive:r.is_active,createdAt:r.created_at,updatedAt:r.updated_at})); }),
  listSmsPackageRequests: platformAdminProcedure.query(async ()=>{ const {data,error}=await supabaseAdmin().from("sms_package_requests").select("id,tenant_id,requested_by_user_id,requested_messages,approved_messages,status,note,reviewed_by_user_id,reviewed_at,created_at,updated_at").order("created_at",{ascending:false}).limit(100); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل طلبات حزم الرسائل من Supabase."}); return (data??[]).map(r=>({request:{id:Number(r.id),tenantId:Number(r.tenant_id),requestedByUserId:Number(r.requested_by_user_id),requestedMessages:r.requested_messages,approvedMessages:r.approved_messages,status:r.status,note:r.note,reviewedByUserId:r.reviewed_by_user_id?Number(r.reviewed_by_user_id):null,reviewedAt:r.reviewed_at,createdAt:r.created_at,updatedAt:r.updated_at},tenantName:"—",ownerName:"—"})); }),
  reviewSmsPackageRequest: platformAdminProcedure.input(z.object({id:z.number().int().positive(),status:z.enum(["approved","rejected"]),approvedMessages:z.number().int().min(0).max(100000000),note:z.string().max(2000).optional()})).mutation(async ({ctx,input})=>reviewSmsPackageRequestSupabase({actorUserId:ctx.user.id,requestId:input.id,status:input.status,approvedMessages:input.approvedMessages,note:input.note})),
  platformAccessDirectory: platformAdminProcedure.query(async (): Promise<{accounts: AdminRecord[]; invitations: AdminRecord[]}>=>{ const [accounts,invitations]=await Promise.all([supabaseAdmin().from("users").select("id,name,email,platform_role,account_status,last_signed_in").eq("role","admin").order("last_signed_in",{ascending:false}).limit(100),supabaseAdmin().from("platform_access_invitations").select("id,email,platform_role,status,expires_at,accepted_at,invited_by_user_id").order("created_at",{ascending:false}).limit(100)]); if(accounts.error||invitations.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل دليل وصول المنصة من Supabase."}); return {accounts:(accounts.data??[]) as AdminRecord[],invitations:(invitations.data??[]) as AdminRecord[]}; }),
  userDirectory: platformAdminProcedure.query(async ()=>{ const {data,error}=await supabaseAdmin().from("users").select("id,name,email,role,platform_role,account_status,last_signed_in").order("last_signed_in",{ascending:false}).limit(200); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل دليل المستخدمين من Supabase."}); return (data??[]).map(r=>({id:Number(r.id),name:r.name,email:r.email,role:r.role,platformRole:r.platform_role,accountStatus:r.account_status,lastSignedIn:r.last_signed_in})); }),
  financeOverview: platformFinanceProcedure.query(async (): Promise<AdminRecord>=>{ const {data,error}=await supabaseAdmin().rpc("powerhub_finance_overview"); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل الملخص المالي المركزي من Supabase."}); return ((data as AdminRecord[])?.[0]??{subscriptions:[],collections:{amount:0,count:0}}) as AdminRecord; }),
  rolePolicies: platformAdminProcedure.query(async (): Promise<AdminRecord[]>=>{ const {data,error}=await supabaseAdmin().from("platform_role_policies").select("id,role,is_enabled,capabilities,updated_at").order("role",{ascending:true}); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل سياسات الأدوار من Supabase."}); return (data??[]) as AdminRecord[]; }),

  createGeneratorOwner: retiredMutation("إنشاء صاحب مولد"),
  createGeneratorOwnerWithTemporaryPassword: retiredMutation("إنشاء صاحب مولد بكلمة مرور مؤقتة"),
  updateComplaint: retiredMutation("تحديث الشكوى"),
  setTenantStatus: retiredMutation("تغيير حالة مساحة صاحب المولد"),
  setGeneratorStatus: retiredMutation("تغيير حالة المولد"),
  approvePendingGenerator: retiredMutation("اعتماد مولد معلّق"),
  invitePlatformAccess: retiredMutation("دعوة وصول لإدارة المنصة"),
  setPlatformAccountStatus: retiredMutation("تغيير حالة حساب إدارة المنصة"),
  setPlatformAccessRole: retiredMutation("تغيير دور حساب إدارة المنصة"),
  inviteTenantAccess: retiredMutation("دعوة وصول إلى مساحة صاحب المولد"),
  createSmsPlan: retiredMutation("إنشاء باقة SMS"),
  updateSmsPlan: retiredMutation("تحديث باقة SMS"),
  createTariffPolicy: retiredMutation("إنشاء سياسة تسعير"),
  saveTenantBranchSettings: retiredMutation("حفظ إعدادات الفروع"),
  savePlatformSetting: retiredMutation("حفظ إعدادات المنصة"),
  requestOwnerAccessRecovery: retiredMutation("طلب استرداد وصول صاحب المولد"),
  saveRolePolicy: retiredMutation("حفظ سياسة صلاحيات الدور"),
  sendOwnerUsageAlert: retiredMutation("إرسال تنبيه استخدام صاحب المولد"),
  savePlatformSmsFallbackProvider: retiredMutation("حفظ مزود SMS الاحتياطي"),
  savePlatformTweetSmsAccount: retiredMutation("حفظ حساب TweetSMS المركزي"),
  testPlatformTweetSmsAccount: retiredMutation("فحص حساب TweetSMS المركزي"),
  platformTweetSmsReport: platformAdminProcedure.input(z.any().optional()).query(async (): Promise<{account: AdminRecord|null; total:number; usageRows:AdminRecord[]; alerts:AdminRecord[]}>=>({account:null,total:0,usageRows:[],alerts:[]})),
  saveTweetSmsAccount: retiredMutation("حفظ حساب TweetSMS للمولد"),
  testTweetSmsAccount: retiredMutation("فحص حساب TweetSMS للمولد"),
  listNotifications: platformAdminProcedure.input(z.any().optional()).query(async (): Promise<AdminRecord[]>=>[]),
  operationalMonitoring: platformAdminProcedure.query(async (): Promise<{health:AdminRecord[]; alerts:AdminRecord[]}>=>({health:[],alerts:[]})),
  securityCenter: platformAdminProcedure.query(async (): Promise<{events:AdminRecord[]; settings:AdminRecord[]}>=>({events:[],settings:[]})),
  recordSecurityEvent: platformAdminProcedure.input(z.any()).mutation(async()=>({success:true as const})),
  saveSecuritySetting: platformAdminProcedure.input(z.any()).mutation(async()=>({success:true as const})),
  advancedDashboard: platformAdminProcedure.query(async (): Promise<{kpis:AdminRecord;monthlyGrowth:AdminRecord[];consumptionByRegion:AdminRecord[];collectionsByGenerator:AdminRecord[];latestGenerators:AdminRecord[];recentComplaints:AdminRecord[];expiringSubscriptions:AdminRecord[]}>=>({kpis:{},monthlyGrowth:[],consumptionByRegion:[],collectionsByGenerator:[],latestGenerators:[],recentComplaints:[],expiringSubscriptions:[]})),
  globalSearch: platformAdminProcedure.input(z.object({query:z.string().trim().min(2).max(100)})).query(async (): Promise<AdminRecord[]>=>[]),
  listComplaints: platformAdminProcedure.input(z.any().optional()).query(async (): Promise<AdminRecord[]>=>[]),
  listTariffPolicies: platformAdminProcedure.query(async (): Promise<AdminRecord[]>=>[]),
  listTenantBranchSettings: platformAdminProcedure.query(async (): Promise<AdminRecord[]>=>[]),
  platformConfiguration: platformAdminProcedure.query(async (): Promise<{settings:AdminRecord[];recoveries:AdminRecord[];currentTariff:AdminRecord|null}>=>({settings:[],recoveries:[],currentTariff:null})),
  impersonationStatus: platformAdminProcedure.query(async()=>({enabled:false as const,confirmationRequired:true as const,reason:"هذا المسار معطل أثناء الترحيل."})),
  generatorDetails: platformAdminProcedure.input(z.object({generatorId:z.number().int().positive()})).query(async (): Promise<AdminRecord>=>({generator:null,subscriberSummary:{},invoices:[],activity:[]})),
});

export type AdminRouter = typeof adminRouter;
