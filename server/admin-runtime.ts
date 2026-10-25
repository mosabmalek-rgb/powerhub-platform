import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { savePlatformSetting as savePlatformSettingSupabase } from "./platform-setting-supabase";
import { encryptTenantCredential } from "./tenant-crypto";
import { ownerOverviewFromSupabase, platformSnapshotFromSupabase } from "./admin-supabase";
import { getEffectiveAdminSubscriptionStatus, isEffectivelyActiveAdminSubscription, getNextRenewalEndDate } from "./admin-subscription-lifecycle";
import { attachOwnerUser as attachOwnerUserSupabase, quickUpgradeOwnerPlan as quickUpgradeOwnerPlanSupabase, renewSubscription as renewSubscriptionSupabase, reviewSmsPackageRequest as reviewSmsPackageRequestSupabase, reviewSubscriptionUpgradeRequest as reviewSubscriptionUpgradeRequestSupabase, setTenantMembershipStatus as setTenantMembershipStatusSupabase, updateSubscription as updateSubscriptionSupabase } from "./admin-supabase-writes";

const packageCodeSchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/);
const subscriptionStatusSchema = z.enum(["trial", "active", "overdue", "suspended", "cancelled"]);
const billingCycleSchema = z.enum(["monthly", "yearly"]);
type PlatformRole = "platform_owner" | "platform_admin" | "finance_admin";
type AdminRecord = Record<string, any>;

function requirePlatformRoles(allowedRoles: PlatformRole[]) {
  return authenticatedProcedure.use(({ ctx, next }) => {
    const role = ctx.user.platformRole;
    if (ctx.user.role !== "admin" || ctx.user.accountStatus !== "active" || !role || !allowedRoles.includes(role as PlatformRole)) {
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
    clientOperationId:z.string().uuid(),
    companyName:z.string().min(2).max(180), ownerName:z.string().min(2).max(180), identityNumber:z.string().min(4).max(50), ownerPhone:z.string().min(5).max(30), ownerWhatsapp:z.preprocess(v=>typeof v==="string"&&!v.trim()?undefined:v,z.string().min(5).max(30).optional()), ownerEmail:z.string().email(), temporaryPassword:z.string().min(8).max(128), packageCode:packageCodeSchema.default("basic"), billingCycle:billingCycleSchema.default("monthly"), subscriptionDuration:z.number().int().min(1).max(60).default(1), trialEnabled:z.boolean().default(false), trialDurationDays:z.number().int().min(1).max(3650).optional(),
  })).mutation(async ({ctx,input}) => {
    const email=input.ownerEmail.trim().toLowerCase();
    const normalized = {
      companyName: input.companyName.trim(), ownerName: input.ownerName.trim(),
      identityNumber: input.identityNumber.trim(), ownerPhone: input.ownerPhone.trim(),
      ownerWhatsapp: input.ownerWhatsapp?.trim() || null, ownerEmail: email,
      temporaryPassword: input.temporaryPassword, packageCode: input.packageCode,
      billingCycle: input.billingCycle, subscriptionDuration: input.subscriptionDuration,
      trialEnabled: input.trialEnabled, trialDurationDays: input.trialEnabled ? (input.trialDurationDays ?? 8) : null,
    };
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    const admin=supabaseAdmin();
    const begin = await admin.rpc("powerhub_admin_begin_generator_owner_provisioning", {
      p_actor_user_id: ctx.user.id, p_client_operation_id: input.clientOperationId,
      p_owner_email: email, p_request_fingerprint: fingerprint,
    });
    if (begin.error || !begin.data?.[0]) {
      throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تثبيت عملية التسجيل بأمان؛ لم يُنشأ حساب جديد."});
    }
    const operation = begin.data[0];
    if (operation.needs_reconciliation) {
      throw new TRPCError({code:"CONFLICT",message:"نتيجة إنشاء حساب الدخول السابقة غير محسومة. لا تعِد إنشاء الحساب؛ يلزم التحقق من سجل العملية قبل المتابعة."});
    }
    if (operation.success && operation.replayed) return {
      tenant_id: operation.tenant_id, owner_user_id: operation.owner_user_id,
      site_id: operation.site_id, subscription_id: operation.subscription_id, replayed: true,
    };
    let authUserId: string | null = operation.auth_user_id ?? null;
    if (operation.can_create_auth) {
      let authResult;
      try {
        authResult = await admin.auth.admin.createUser({
          email, password: input.temporaryPassword, email_confirm: true,
          user_metadata: {name: normalized.ownerName, must_change_password: true},
        });
      } catch (error) {
        console.error("[AdminSupabase] owner Auth creation outcome indeterminate", { errorName: error instanceof Error ? error.name : "unknown" });
        throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"نتيجة إنشاء حساب الدخول غير محسومة؛ أُبقيت العملية محجوزة لمنع إنشاء حساب مكرر."});
      }
      if (authResult.error || !authResult.data.user) {
        // Only a definitive duplicate/validation response is safe to release.
        if (authResult.error?.status === 422) {
          await admin.rpc("powerhub_admin_cancel_generator_owner_provisioning", {
            p_actor_user_id: ctx.user.id, p_client_operation_id: input.clientOperationId,
            p_request_fingerprint: fingerprint, p_auth_user_id: null,
          });
          throw new TRPCError({code:"CONFLICT",message:"البريد الإلكتروني مستخدم مسبقًا أو لا يمكن إنشاء الحساب بهذه البيانات."});
        }
        throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تأكيد إنشاء حساب الدخول؛ أُبقيت العملية للمصالحة الآمنة."});
      }
      authUserId = authResult.data.user.id;
      const attach = await admin.rpc("powerhub_admin_attach_generator_owner_provisioning_auth", {
        p_actor_user_id: ctx.user.id, p_client_operation_id: input.clientOperationId,
        p_auth_user_id: authUserId, p_request_fingerprint: fingerprint,
      });
      if (attach.error || !attach.data?.[0]?.attached) {
        // The Auth user may exist. Preserve the operation and identity for a safe retry.
        throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"أُنشئ حساب الدخول لكن تعذر ربطه بسجل العملية؛ لا تُعد المحاولة بمعرّف جديد."});
      }
    }
    if (!authUserId) {
      throw new TRPCError({code:"CONFLICT",message:"عملية التسجيل موجودة لكنها تحتاج إلى مصالحة؛ لم يُنشأ حساب إضافي."});
    }
    const identity=encryptTenantCredential(normalized.identityNumber);
    const endDate = normalized.trialEnabled ? null : addSubscriptionPeriod(new Date(), normalized.billingCycle, normalized.subscriptionDuration).toISOString();
    const result = await admin.rpc("powerhub_admin_complete_generator_owner_provisioning", {
      p_actor_user_id: ctx.user.id, p_client_operation_id: input.clientOperationId,
      p_auth_user_id: authUserId, p_tenant_name: normalized.companyName,
      p_slug: `owner-${crypto.randomUUID().replaceAll("-","")}`,
      p_company_name: normalized.companyName, p_owner_name: normalized.ownerName,
      p_identity_ciphertext: identity.ciphertext, p_identity_iv: identity.iv,
      p_identity_last4: normalized.identityNumber.slice(-4), p_owner_phone: normalized.ownerPhone,
      p_owner_whatsapp: normalized.ownerWhatsapp, p_owner_email: email,
      p_site_name: "الفرع الرئيسي", p_site_code: `SITE-${crypto.randomUUID().slice(0,8).toUpperCase()}`,
      p_package_code: normalized.packageCode, p_billing_cycle: normalized.billingCycle,
      p_subscription_status: normalized.trialEnabled ? "trial" : "active",
      p_ends_at: endDate, p_trial_duration_days: normalized.trialDurationDays ?? 8,
    });
    if (!result.error && result.data?.[0]?.success) {
      return {
        tenant_id: result.data[0].tenant_id, owner_user_id: result.data[0].owner_user_id,
        site_id: result.data[0].site_id, subscription_id: result.data[0].subscription_id,
        replayed: result.data[0].replayed,
      };
    }
    const sqlRollbackConfirmed = typeof result.error?.code === "string" && /^[0-9A-Z]{5}$/.test(result.error.code);
    if (sqlRollbackConfirmed) {
      // Close the operation first. A durable cancelled tombstone prevents retries
      // from attaching a deleted Auth user or creating a second identity.
      const cancellation = await admin.rpc("powerhub_admin_cancel_generator_owner_provisioning", {
        p_actor_user_id: ctx.user.id, p_client_operation_id: input.clientOperationId,
        p_request_fingerprint: fingerprint, p_auth_user_id: authUserId,
      });
      const cancelled = !cancellation.error && cancellation.data?.[0]?.cancelled === true;
      if (!cancelled) {
        console.error("[AdminSupabase] owner provisioning cancellation failed", {
          code: cancellation.error?.code ?? null,
        });
        throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تراجعت معاملة قاعدة البيانات، لكن تعذر إغلاق سجل العملية بأمان؛ احتُفظ بحساب الدخول لمنع كسر إمكانية المصالحة."});
      }
      const cleanup = await admin.auth.admin.deleteUser(authUserId);
      if (!cleanup.error) {
        throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"رفضت قاعدة البيانات التسجيل؛ أُغلقت العملية وأُلغي حساب الدخول التعويضيًا."});
      }
      console.error("[AdminSupabase] owner provisioning Auth compensation failed after durable cancellation", {
        code: cleanup.error.code ?? null,
      });
      throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"أُغلقت عملية التسجيل بأمان لكن تعذر حذف حساب الدخول التعويضي؛ يلزم تنظيفه عبر مسار المصالحة، ولن تُعاد العملية تلقائيًا."});
    }
    // A lost RPC response may mean the transaction committed. Preserve Auth and operation for replay.
    throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تأكيد نتيجة تسجيل صاحب المولد. أعد المحاولة بالعملية نفسها؛ سيمنع معرّف العملية تكرار الاشتراك."});
  }),

  overview: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive().optional()}).optional()).query(async ({input}) => { const owners=await ownerOverviewFromSupabase(input?.tenantId); const totals=owners.reduce((a,item)=>({generatorOwners:a.generatorOwners+1,residential:a.residential+item.subscribers.residential,commercial:a.commercial+item.subscribers.commercial,subscribers:a.subscribers+item.subscribers.total,activeSubscriptions:a.activeSubscriptions+(isEffectivelyActiveAdminSubscription(item.subscription?.status,item.subscription?.endsAt,item.subscription?.archivedAt)?1:0)}),{generatorOwners:0,residential:0,commercial:0,subscribers:0,activeSubscriptions:0}); return {totals,owners}; }),
  listOwners: platformAdminProcedure.query(async ()=>ownerOverviewFromSupabase()),
  platformSnapshot: platformAdminProcedure.query(async ()=>platformSnapshotFromSupabase()),
  listPlatformSmsFallbackProviders: platformAdminProcedure.query(async ()=>{ const {data,error}=await supabaseAdmin().from("platform_sms_fallback_providers").select("id,name,provider_key,api_endpoint,sender_name,priority,integration_status,is_active,credential_ciphertext,credential_iv,last_tested_at,last_error,updated_at").order("priority",{ascending:true}).order("updated_at",{ascending:false}); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل مزودي الرسائل الاحتياطيين من Supabase."}); return (data??[]).map(p=>platformSmsFallbackProviderSummary({id:Number(p.id),name:p.name,providerKey:p.provider_key,apiEndpoint:p.api_endpoint,senderName:p.sender_name,priority:Number(p.priority),integrationStatus:p.integration_status as "pending_contract"|"ready",isActive:p.is_active,credentialCiphertext:p.credential_ciphertext,credentialIv:p.credential_iv,lastTestedAt:p.last_tested_at?new Date(p.last_tested_at):null,lastError:p.last_error,updatedAt:new Date(p.updated_at)})); }),
  getPlatformTweetSmsAccount: platformAdminProcedure.query(async ()=>{ const {data,error}=await supabaseAdmin().from("platform_tweetsms_accounts").select("id,api_endpoint,sender_name,low_balance_threshold,last_provider_balance,last_balance_checked_at,last_tested_at,last_error,is_active,credential_ciphertext,credential_iv").order("updated_at",{ascending:false}).limit(1).maybeSingle(); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل إعدادات مزود الرسائل المركزي من Supabase."}); if(!data) return null; return {id:Number(data.id),apiEndpoint:data.api_endpoint,senderName:data.sender_name,lowBalanceThreshold:Number(data.low_balance_threshold),lastProviderBalance:data.last_provider_balance,lastBalanceCheckedAt:data.last_balance_checked_at,lastTestedAt:data.last_tested_at,lastError:data.last_error,isActive:data.is_active,configured:Boolean(data.credential_ciphertext&&data.credential_iv)}; }),
  listTweetSmsAccounts: platformAdminProcedure.query(async ()=>{ const {data,error}=await supabaseAdmin().from("tenant_tweetsms_accounts").select("id,tenant_id,api_endpoint,sender_name,monthly_limit,is_active,last_tested_at,last_error,updated_at").order("updated_at",{ascending:false}).limit(500); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل حسابات TweetSMS من Supabase."}); return (data??[]).map(r=>({id:Number(r.id),tenantId:Number(r.tenant_id),apiEndpoint:r.api_endpoint,senderName:r.sender_name,monthlyLimit:Number(r.monthly_limit),usedThisMonth:0,remaining:Number(r.monthly_limit),isActive:r.is_active,configured:Boolean(r.api_endpoint),lastTestedAt:r.last_tested_at,lastError:r.last_error,updatedAt:r.updated_at})); }),
  listActiveTenantAddons: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().from("tenant_addon_requests")
      .select("id,tenant_id,addon_code,quantity,status,duration_days,starts_at,ends_at")
      .eq("status","approved")
      .gt("ends_at",new Date().toISOString())
      .order("ends_at",{ascending:true})
      .limit(2000);
    if (error) throw new TRPCError({ code:"INTERNAL_SERVER_ERROR", message:"تعذر تحميل الإضافات النشطة." });
    return (data ?? []).map((r:any)=>({
      addonRequestId:Number(r.id),
      tenantId:Number(r.tenant_id),
      addonCode:r.addon_code,
      quantity:Number(r.quantity),
      durationDays:Number(r.duration_days ?? 30),
      startsAt:r.starts_at,
      endsAt:r.ends_at,
    }));
  }),
  listTenantAddonRequests: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_admin_tenant_addon_requests");
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طلبات الإضافات." });
    return (data ?? []).map((r: any) => ({ id:Number(r.id), tenantId:Number(r.tenant_id), siteId:r.site_id?Number(r.site_id):null, addonCode:r.addon_code, quantity:Number(r.quantity), status:r.status, note:r.note, createdAt:r.created_at, reviewedAt:r.reviewed_at, startsAt:r.starts_at??null, endsAt:r.ends_at??null, tenantName:r.tenant_name??"—", ownerName:r.owner_name??"—", ownerEmail:r.owner_email??null }));
  }),
  reviewTenantAddonRequest: platformAdminProcedure.input(z.object({ id:z.number().int().positive(), decision:z.enum(["approved","rejected"]), note:z.string().trim().max(1000).optional(), durationDays:z.number().int().min(1).max(3650).optional() })).mutation(async ({ctx,input}) => {
    const { data,error } = await supabaseAdmin().rpc("powerhub_admin_review_tenant_addon_request",{p_actor_user_id:ctx.user.id,p_request_id:input.id,p_decision:input.decision,p_note:input.note??null,p_duration_days:input.durationDays ?? null});
    if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر مراجعة طلب الإضافة."});
    const row = data?.[0];
    if(!row?.success) throw new TRPCError({code:"PRECONDITION_FAILED",message:"لم تُعتمد عملية طلب الإضافة بنجاح."});
    return {success:true,status:row.status??input.decision,endsAt:row.ends_at??null};
  }),
  listSubscriptionUpgradeRequests: platformAdminProcedure.query(async (): Promise<AdminRecord[]>=>{ const {data,error}=await supabaseAdmin().rpc("powerhub_admin_subscription_upgrade_requests"); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل طلبات ترقية الباقات من Supabase."}); return (data??[]).map((r: AdminRecord)=>({id:Number(r.id),tenantId:Number(r.tenant_id),currentPackageCode:r.current_package_code,requestedPackageCode:r.requested_package_code,status:r.status,note:r.note,createdAt:r.created_at,reviewedAt:r.reviewed_at,tenantName:r.tenant_name??"—",ownerName:r.owner_name??"—",ownerEmail:r.owner_email??null})); }),
  reviewSubscriptionUpgradeRequest: platformAdminProcedure.input(z.object({id:z.number().int().positive(),decision:z.enum(["approved","rejected"]),note:z.string().trim().max(1000).optional()})).mutation(async ({ctx,input})=>reviewSubscriptionUpgradeRequestSupabase({actorUserId:ctx.user.id,requestId:input.id,decision:input.decision,note:input.note})),
  quickUpgradeOwnerPlan: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),packageCode:packageCodeSchema,note:z.string().trim().max(1000).optional()})).mutation(async ({ctx,input})=>quickUpgradeOwnerPlanSupabase({actorUserId:ctx.user.id,tenantId:input.tenantId,packageCode:input.packageCode,note:input.note??""})),
  setTenantMembershipStatus: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),userId:z.number().int().positive(),status:z.enum(["active","suspended","revoked"])})).mutation(async ({ctx,input})=>setTenantMembershipStatusSupabase({actorUserId:ctx.user.id,tenantId:input.tenantId,userId:input.userId,status:input.status})),
  setPlatformAccountStatus: platformAdminProcedure.input(z.object({userId:z.number().int().positive(),status:z.enum(["active","locked","disabled"])})).mutation(async ({ctx,input})=>{
    if (ctx.user.platformRole !== "platform_owner") throw new TRPCError({code:"FORBIDDEN",message:"تغيير حالة حسابات إدارة المنصة متاح لمالك المنصة فقط."});
    const {data,error}=await supabaseAdmin().rpc("powerhub_admin_set_platform_account_status",{p_actor_user_id:ctx.user.id,p_target_user_id:input.userId,p_account_status:input.status});
    if(error) throw new TRPCError({code:"BAD_REQUEST",message:error.message.includes("TARGET_IS_OWNER")?"لا يمكن تعطيل مالك المنصة.":error.message.includes("ACCOUNT_NOT_FOUND")||error.message.includes("TARGET_NOT_FOUND")?"حساب المنصة غير موجود.":"تعذر تغيير حالة حساب المنصة."});
    return {success:Boolean(data?.[0]?.success ?? true),status:data?.[0]?.account_status ?? input.status};
  }),
  attachOwnerUser: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),userId:z.number().int().positive(),siteId:z.number().int().positive().optional()})).mutation(async ({ctx,input})=>attachOwnerUserSupabase({actorUserId:ctx.user.id,tenantId:input.tenantId,userId:input.userId,siteId:input.siteId})),
  updateSubscription: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),packageCode:packageCodeSchema,status:subscriptionStatusSchema,billingCycle:billingCycleSchema,endsAt:z.date(),autoRenew:z.boolean(),notes:z.string().max(2000).optional(),smsPlanId:z.number().int().positive().nullable().optional()})).mutation(async ({ctx,input})=>updateSubscriptionSupabase({actorUserId:ctx.user.id,tenantId:input.tenantId,packageCode:input.packageCode,status:input.status,billingCycle:input.billingCycle,endsAt:input.endsAt,autoRenew:input.autoRenew,notes:input.notes,smsPlanId:input.smsPlanId})),  cancelTenantSubscription: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),graceDays:z.number().int().min(1).max(30).default(10),reason:z.string().trim().max(1000).optional()})).mutation(async ({ctx,input})=>{
    const {data,error}=await supabaseAdmin().rpc("powerhub_admin_cancel_tenant_subscription",{p_actor_user_id:ctx.user.id,p_tenant_id:input.tenantId,p_grace_days:input.graceDays,p_reason:input.reason??null});
    if(error) throw new TRPCError({code:"BAD_REQUEST",message:error.message.includes("ALREADY_CANCELLED")?"الاشتراك ملغى بالفعل.":error.message.includes("SUBSCRIPTION_NOT_FOUND")?"لا يوجد اشتراك لهذا الحساب.":"تعذر إلغاء الاشتراك."});
    const row=data?.[0]; if(!row) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد عملية الإلغاء نتيجة صالحة."});
    return {success:Boolean(row.success),tenantId:Number(row.tenant_id),subscriptionId:Number(row.subscription_id),readOnlyUntil:row.read_only_until};
  }),
  restoreTenantSubscription: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),reason:z.string().trim().max(1000).optional()})).mutation(async ({ctx,input})=>{
    const {data,error}=await supabaseAdmin().rpc("powerhub_admin_restore_tenant_subscription",{p_actor_user_id:ctx.user.id,p_tenant_id:input.tenantId,p_reason:input.reason??null});
    if(error) throw new TRPCError({code:"BAD_REQUEST",message:error.message.includes("READ_ONLY_WINDOW_EXPIRED")?"انتهت فترة الاحتفاظ للقراءة فقط.":error.message.includes("ORIGINAL_SUBSCRIPTION_EXPIRED")?"انتهت مدة الاشتراك الأصلية.":"تعذر استعادة الاشتراك."});
    const row=data?.[0]; if(!row) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد عملية الاستعادة نتيجة صالحة."});
    return {success:Boolean(row.success),tenantId:Number(row.tenant_id),subscriptionId:Number(row.subscription_id),endsAt:row.ends_at};
  }),
  renewSubscription: platformAdminProcedure.input(z.object({
    subscriptionId:z.number().int().positive(),
    endsAt:z.coerce.date(),
    packageCode:packageCodeSchema,
    addonDecisions:z.array(z.object({addonRequestId:z.number().int().positive(),decision:z.enum(["renew","expire"]),durationDays:z.number().int().min(1).max(3650).optional()})).default([]),
    requestKey:z.string().uuid()
  })).mutation(async ({ctx,input})=>renewSubscriptionSupabase({actorUserId:ctx.user.id,subscriptionId:input.subscriptionId,endsAt:input.endsAt,packageCode:input.packageCode,addonDecisions:input.addonDecisions,requestKey:input.requestKey})),
  listSmsPlans: platformAdminProcedure.query(async ()=>{ const {data,error}=await supabaseAdmin().from("platform_sms_plans").select("id,code,name,description,included_messages,price_amount,currency,is_active,created_at,updated_at").order("included_messages",{ascending:true}); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل باقات الرسائل من Supabase."}); return (data??[]).map(r=>({id:Number(r.id),code:r.code,name:r.name,description:r.description,includedMessages:r.included_messages,priceAmount:Number(r.price_amount??0),currency:r.currency??"ILS",isActive:r.is_active,createdAt:r.created_at,updatedAt:r.updated_at})); }),
  listSmsPackageRequests: platformAdminProcedure.query(async ()=>{ const admin=supabaseAdmin(); const {data,error}=await admin.from("sms_package_requests").select("id,tenant_id,requested_by_user_id,sms_plan_id,requested_messages,requested_price,currency,approved_messages,status,note,reviewed_by_user_id,reviewed_at,created_at,updated_at").order("created_at",{ascending:false}).limit(200); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل طلبات رصيد الرسائل من Supabase."}); const tenantIds=[...new Set((data??[]).map(r=>Number(r.tenant_id)))]; const userIds=[...new Set((data??[]).map(r=>Number(r.requested_by_user_id)))]; const [tenants,owners,users,plans]=await Promise.all([tenantIds.length?admin.from("tenants").select("id,name").in("id",tenantIds):Promise.resolve({data:[],error:null}),tenantIds.length?admin.from("tenant_owner_profiles").select("tenant_id,full_name,company_name").in("tenant_id",tenantIds):Promise.resolve({data:[],error:null}),userIds.length?admin.from("users").select("id,name,email").in("id",userIds):Promise.resolve({data:[],error:null}),admin.from("platform_sms_plans").select("id,name")]); const tenantMap=new Map((tenants.data??[]).map(r=>[Number(r.id),r.name])); const ownerMap=new Map((owners.data??[]).map(r=>[Number(r.tenant_id),r])); const userMap=new Map((users.data??[]).map(r=>[Number(r.id),r])); const planMap=new Map((plans.data??[]).map(r=>[Number(r.id),r.name])); const tenantError=tenants.error||owners.error||users.error||plans.error; if(tenantError) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل أسماء أصحاب المولدات وبيانات طلبات SMS."}); return (data??[]).map(r=>{const tenantId=Number(r.tenant_id);const owner=ownerMap.get(tenantId);return {request:{id:Number(r.id),tenantId,requestedByUserId:Number(r.requested_by_user_id),packageId:r.sms_plan_id?Number(r.sms_plan_id):null,packageName:r.sms_plan_id?planMap.get(Number(r.sms_plan_id))??null:null,requestedMessages:Number(r.requested_messages),requestedPrice:Number(r.requested_price??0),currency:r.currency??"ILS",approvedMessages:Number(r.approved_messages??0),status:r.status,note:r.note,reviewedByUserId:r.reviewed_by_user_id?Number(r.reviewed_by_user_id):null,reviewedAt:r.reviewed_at,createdAt:r.created_at,updatedAt:r.updated_at},tenantName:tenantMap.get(tenantId)??owner?.company_name??"مساحة غير مسماة",ownerName:owner?.full_name??userMap.get(Number(r.requested_by_user_id))?.name??userMap.get(Number(r.requested_by_user_id))?.email??"غير محدد"};}); }),
  listSmsWalletSummaries: platformAdminProcedure.query(async ({ctx})=>{ const {data,error}=await supabaseAdmin().rpc("powerhub_admin_sms_wallet_summaries",{p_actor_user_id:ctx.user.id}); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل ملخص أرصدة SMS الدائمة."}); return (data??[]).map((r:any)=>({tenantId:Number(r.tenant_id),tenantName:r.tenant_name,companyName:r.company_name,ownerName:r.owner_name,totalCredited:Number(r.total_credited??0),usedSegments:Number(r.used_segments??0),remainingMessages:Number(r.remaining_messages??0),providerMonthlyLimit:Number(r.provider_monthly_limit??0),providerMonthlyUsed:Number(r.provider_monthly_used??0),lastRechargeAt:r.last_recharge_at})); }),
  listSmsRechargeLedger: platformAdminProcedure.query(async ()=>{ const admin=supabaseAdmin(); const {data,error}=await admin.from("tenant_sms_recharge_ledger").select("id,tenant_id,request_id,provider_mode,status,requested_messages,credited_messages,provider_reference,confirmed_at,requested_by_user_id,processed_by_user_id,failure_reason,note,created_at,updated_at").order("created_at",{ascending:false}).limit(250); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل سجل شحن أرصدة SMS."}); const tenantIds=[...new Set((data??[]).map(r=>Number(r.tenant_id)))]; const [tenants,owners]=await Promise.all([tenantIds.length?admin.from("tenants").select("id,name").in("id",tenantIds):Promise.resolve({data:[],error:null}),tenantIds.length?admin.from("tenant_owner_profiles").select("tenant_id,full_name,company_name").in("tenant_id",tenantIds):Promise.resolve({data:[],error:null})]); if(tenants.error||owners.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل أسماء أصحاب المولدات لسجل الشحن."}); const tm=new Map((tenants.data??[]).map(r=>[Number(r.id),r.name])); const om=new Map((owners.data??[]).map(r=>[Number(r.tenant_id),r])); return (data??[]).map(r=>{const tid=Number(r.tenant_id);const owner=om.get(tid);return {id:Number(r.id),tenantId:tid,tenantName:tm.get(tid)??owner?.company_name??"مساحة غير مسماة",companyName:owner?.company_name??tm.get(tid)??"—",ownerName:owner?.full_name??"غير محدد",requestId:r.request_id?Number(r.request_id):null,providerMode:r.provider_mode,status:r.status,requestedMessages:Number(r.requested_messages??0),creditedMessages:Number(r.credited_messages??0),providerReference:r.provider_reference,note:r.note,failureReason:r.failure_reason,requestedByUserId:r.requested_by_user_id?Number(r.requested_by_user_id):null,processedByUserId:r.processed_by_user_id?Number(r.processed_by_user_id):null,confirmedAt:r.confirmed_at,createdAt:r.created_at,updatedAt:r.updated_at};}); }),
  createSmsRechargeRequest: platformAdminProcedure.input(z.object({tenantId:z.number().int().positive(),messages:z.number().int().min(1).max(100000000),note:z.string().trim().min(3).max(1000),idempotencyKey:z.string().uuid()})).mutation(async ({ctx,input})=>{ const {data,error}=await supabaseAdmin().rpc("powerhub_admin_create_sms_recharge_request",{p_actor_user_id:ctx.user.id,p_tenant_id:input.tenantId,p_messages:input.messages,p_note:input.note,p_idempotency_key:input.idempotencyKey}); if(error){if(error.message.includes("TENANT_NOT_FOUND"))throw new TRPCError({code:"NOT_FOUND",message:"صاحب المولد غير موجود."});if(error.message.includes("SITE_NOT_FOUND"))throw new TRPCError({code:"PRECONDITION_FAILED",message:"لا يمكن إنشاء طلب الشحن قبل وجود فرع صالح ضمن مساحة صاحب المولد."});if(error.message.includes("SMS_RECHARGE_REQUEST_PENDING"))throw new TRPCError({code:"CONFLICT",message:"يوجد طلب شحن معلّق لهذا صاحب المولد بالفعل."});throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر إنشاء طلب شحن رصيد SMS."});} const row=data?.[0]; if(!row)throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُرجع قاعدة البيانات طلب الشحن."}); return {id:Number(row.ledger_id),tenantId:Number(row.tenant_id),status:String(row.status)}; }),
  confirmSmsRecharge: platformAdminProcedure.input(z.object({ledgerId:z.number().int().positive(),creditedMessages:z.number().int().min(1).max(100000000),providerReference:z.string().max(200).optional(),note:z.string().max(1000).optional()})).mutation(async ({ctx,input})=>{ const {data,error}=await supabaseAdmin().rpc("powerhub_admin_confirm_sms_recharge",{p_actor_user_id:ctx.user.id,p_ledger_id:input.ledgerId,p_status:"manual_confirmed",p_credited_messages:input.creditedMessages,p_provider_reference:input.providerReference??null,p_provider_balance:null,p_failure_reason:input.note??null}); if(error){if(error.message.includes("SMS_RECHARGE_ALREADY_FINALIZED"))throw new TRPCError({code:"CONFLICT",message:"تم إنهاء طلب الشحن بالفعل؛ حدّث السجل للتحقق من الرصيد."});throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تأكيد الشحن وإضافة الرصيد."});} const row=data?.[0]; if(!row)throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُرجع قاعدة البيانات نتيجة تأكيد الشحن."}); return {success:Boolean(row.success),status:row.status,creditedMessages:Number(row.credited_messages??0),replayed:Boolean(row.replayed)}; }),
  rejectSmsRechargeRequest: platformAdminProcedure.input(z.object({ledgerId:z.number().int().positive(),reason:z.string().trim().min(3).max(1000)})).mutation(async ({ctx,input})=>{
    const {data,error}=await supabaseAdmin().rpc("powerhub_admin_confirm_sms_recharge",{
      p_actor_user_id:ctx.user.id,p_ledger_id:input.ledgerId,p_status:"failed",p_credited_messages:0,
      p_provider_reference:null,p_provider_balance:null,p_failure_reason:input.reason,
    });
    if(error){if(error.message.includes("SMS_RECHARGE_ALREADY_FINALIZED"))throw new TRPCError({code:"CONFLICT",message:"تم إنهاء طلب الشحن بالفعل؛ حدّث السجل للتحقق من حالته."});throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر رفض طلب الشحن."});}
    const row=data?.[0]; if(!row)throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُرجع قاعدة البيانات نتيجة رفض الشحن."});
    return {success:Boolean(row.success),status:row.status,replayed:Boolean(row.replayed)};
  }),
  createSmsCreditPackage: platformAdminProcedure.input(z.object({code:z.string().trim().min(2).max(80),name:z.string().trim().min(2).max(160),description:z.string().max(1000).optional(),messages:z.number().int().min(1).max(100000000),price:z.number().min(0).max(100000000),currency:z.string().trim().length(3).default("ILS"),isActive:z.boolean().default(true)})).mutation(async ({ctx,input})=>{ const {data,error}=await supabaseAdmin().rpc("powerhub_admin_create_sms_credit_package",{p_actor_user_id:ctx.user.id,p_code:input.code,p_name:input.name,p_description:input.description??null,p_messages:input.messages,p_price:input.price,p_currency:input.currency,p_is_active:input.isActive}); if(error){if(error.message.includes("DUPLICATE_CODE"))throw new TRPCError({code:"CONFLICT",message:"رمز الحزمة مستخدم بالفعل."});throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر إنشاء باقة رصيد SMS."});} const row=data?.[0]; if(!row)throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُرجع قاعدة البيانات باقة الرصيد."}); return {id:Number(row.id),name:row.name}; }),
  updateSmsCreditPackage: platformAdminProcedure.input(z.object({id:z.number().int().positive(),name:z.string().trim().min(2).max(160).optional(),description:z.string().max(1000).optional(),messages:z.number().int().min(1).max(100000000).optional(),price:z.number().min(0).max(100000000).optional(),currency:z.string().trim().length(3).optional(),isActive:z.boolean().optional()})).mutation(async ({ctx,input})=>{ const {data,error}=await supabaseAdmin().rpc("powerhub_admin_update_sms_credit_package",{p_actor_user_id:ctx.user.id,p_id:input.id,p_name:input.name??null,p_description:input.description??null,p_messages:input.messages??null,p_price:input.price??null,p_currency:input.currency??null,p_is_active:input.isActive??null}); if(error)throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحديث باقة رصيد SMS."}); const row=data?.[0]; if(!row)throw new TRPCError({code:"NOT_FOUND",message:"باقة الرصيد غير موجودة."}); return {id:Number(row.id),isActive:Boolean(row.is_active)}; }),
  reviewSmsPackageRequest: platformAdminProcedure.input(z.object({id:z.number().int().positive(),status:z.enum(["approved","rejected"]),approvedMessages:z.number().int().min(0).max(100000000),note:z.string().max(2000).optional()})).mutation(async ({ctx,input})=>reviewSmsPackageRequestSupabase({actorUserId:ctx.user.id,requestId:input.id,status:input.status,approvedMessages:input.approvedMessages,note:input.note})),
  platformAccessDirectory: platformAdminProcedure.query(async (): Promise<{accounts: AdminRecord[]; invitations: AdminRecord[]}>=>{ const [accounts,invitations]=await Promise.all([supabaseAdmin().from("users").select("id,name,email,platform_role,account_status,last_signed_in").eq("role","admin").order("last_signed_in",{ascending:false}).limit(100),supabaseAdmin().from("platform_access_invitations").select("id,email,platform_role,status,expires_at,accepted_at,invited_by_user_id").order("created_at",{ascending:false}).limit(100)]); if(accounts.error||invitations.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل دليل وصول المنصة من Supabase."}); return {accounts:(accounts.data??[]) as AdminRecord[],invitations:(invitations.data??[]) as AdminRecord[]}; }),
  userDirectory: platformAdminProcedure.input(z.object({}).optional()).query(async (): Promise<AdminRecord[]>=>{ const {data,error}=await supabaseAdmin().from("users").select("id,name,email,role,platform_role,account_status,last_signed_in").order("last_signed_in",{ascending:false}).limit(200); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل دليل المستخدمين من Supabase."}); return (data??[]).map(r=>({id:Number(r.id),name:r.name,email:r.email,role:r.role,platformRole:r.platform_role,accountStatus:r.account_status,lastSignedIn:r.last_signed_in})); }),
  financeOverview: platformFinanceProcedure.query(async (): Promise<AdminRecord>=>{ const {data,error}=await supabaseAdmin().rpc("powerhub_finance_overview"); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل الملخص المالي المركزي من Supabase."}); return ((data as AdminRecord[])?.[0]??{subscriptions:[],collections:{amount:0,count:0}}) as AdminRecord; }),
  rolePolicies: platformAdminProcedure.query(async (): Promise<AdminRecord[]>=>{ const {data,error}=await supabaseAdmin().from("platform_role_policies").select("id,role,is_enabled,capabilities,updated_at").order("role",{ascending:true}); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل سياسات الأدوار من Supabase."}); return (data??[]) as AdminRecord[]; }),

  createGeneratorOwner: retiredMutation("إنشاء صاحب مولد"),
  createGeneratorOwnerWithTemporaryPassword: retiredMutation("إنشاء صاحب مولد بكلمة مرور مؤقتة"),
  updateComplaint: retiredMutation("تحديث الشكوى"),
  setTenantStatus: retiredMutation("تغيير حالة مساحة صاحب المولد"),
  setGeneratorStatus: retiredMutation("تغيير حالة المولد"),
  approvePendingGenerator: retiredMutation("اعتماد مولد معلّق"),
  invitePlatformAccess: retiredMutation("دعوة وصول لإدارة المنصة"),
  setPlatformAccessRole: retiredMutation("تغيير دور حساب إدارة المنصة"),
  inviteTenantAccess: retiredMutation("دعوة وصول إلى مساحة صاحب المولد"),
  createSmsPlan: retiredMutation("إنشاء باقة SMS"),
  updateSmsPlan: retiredMutation("تحديث باقة SMS"),
  createTariffPolicy: retiredMutation("إنشاء سياسة تسعير"),
  saveTenantBranchSettings: retiredMutation("حفظ إعدادات الفروع"),
  savePlatformSetting: platformAdminProcedure.input(z.object({
    settingKey:z.string().trim().min(2).max(100),
    isEnabled:z.boolean(),
    message:z.string().max(4000).optional(),
    value:z.record(z.string(),z.unknown()).optional(),
  })).mutation(async ({ctx,input})=>savePlatformSettingSupabase({
    actorUserId:ctx.user.id,settingKey:input.settingKey,isEnabled:input.isEnabled,message:input.message,
    value:input.value as Record<string,unknown>|undefined,
  })),
  requestOwnerAccessRecovery: retiredMutation("طلب استرداد وصول صاحب المولد"),
  saveRolePolicy: retiredMutation("حفظ سياسة الصلاحيات الدور"),
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