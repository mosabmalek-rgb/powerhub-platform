import { useAuth } from "@/_core/hooks/useAuth";
import { describeAuthFailure } from "@/lib/auth-diagnostics";
import { resetSupabaseSessionReadBackoff } from "@/lib/supabase";
import {
  shouldRedirectToLoginWhenNoSession,
  shouldShowSessionRecovery,
} from "@/lib/auth-routing";
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { useLocation } from "wouter";
import { firstPermittedTenantRoute, tenantMenuRouteAllowed } from "@/lib/tenant-menu-access";

type RouteAccessGateProps = {
  children: React.ReactNode;
  platformAdminOnly?: boolean;
  supportOnly?: boolean;
  financeAdminOnly?: boolean;
  featureKey?: "support_chat" | "powerhub_ai_assistant";
  multiBranchOnly?: boolean;
};

export function RouteAccessGate({ children, platformAdminOnly = false, supportOnly = false, financeAdminOnly = false, featureKey, multiBranchOnly = false }: RouteAccessGateProps) {
  const {
    user,
    isAuthenticated,
    loading,
    error,
    logout,
    refresh,
    hasSession,
    powerHubReachable,
  } = useAuth();
  const [, setLocation] = useLocation();
  const isPlatformAdmin = user?.role === "admin" && ["platform_owner", "platform_admin"].includes(user.platformRole ?? "");
  const isPlatformSupport = user?.role === "admin" && user.platformRole === "platform_support";
  const isFinanceAdmin = user?.role === "admin" && user.platformRole === "finance_admin";
  const authCheckFailed = !loading && Boolean(error) && !user;
  const shouldRedirectToLogin = shouldRedirectToLoginWhenNoSession({
    loading,
    isAuthenticated,
    hasSession,
    hasError: Boolean(error),
    hasUser: Boolean(user),
  });
  const showSessionRecovery = shouldShowSessionRecovery({
    loading,
    isAuthenticated,
    hasSession,
    hasError: Boolean(error),
    hasUser: Boolean(user),
  });
  const shouldRedirectUnauthorized = !loading && isAuthenticated && ((platformAdminOnly && !isPlatformAdmin) || (financeAdminOnly && !isFinanceAdmin) || (supportOnly && !isPlatformSupport));

  useEffect(() => {
    if (shouldRedirectToLogin) setLocation("/login");
    else if (shouldRedirectUnauthorized) setLocation("/");
  }, [setLocation, shouldRedirectToLogin, shouldRedirectUnauthorized]);

  if (authCheckFailed) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div className="max-w-md"><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">تعذر التحقق من الجلسة</h1><p className="mt-2 text-sm leading-7 text-slate-400">قد تكون الجلسة موجودة لكن تعذر التحقق منها مؤقتًا. أعد المحاولة قبل تسجيل الخروج حتى لا تفقد حالة العمل الحالية.</p><p role="status" aria-live="polite" className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-6 text-slate-300">{describeAuthFailure(error)}</p><div className="mt-6 flex flex-wrap justify-center gap-3"><button type="button" onClick={() => { resetSupabaseSessionReadBackoff(); void refresh(); }} className="rounded-xl bg-[#F5B800] px-5 py-3 text-sm font-extrabold text-[#0D1117]">إعادة المحاولة واستعادة البيانات</button><button type="button" onClick={() => void logout()} className="rounded-xl border border-white/15 px-5 py-3 text-sm font-bold text-slate-200">تسجيل الخروج</button></div></div></main>;
  }

  if (showSessionRecovery) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div className="max-w-md"><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">لم يكتمل التحقق من الجلسة</h1><p className="mt-2 text-sm leading-7 text-slate-400">لن نعيد توجيهك لتسجيل الدخول لمجرد تعذر التحقق مؤقتًا من جلسة موجودة. أعد المحاولة بعد التأكد من إمكانية الوصول إلى خادم PowerHub.</p><p role="status" aria-live="polite" className="mt-3 text-xs leading-6 text-slate-300">{powerHubReachable ? "الخادم قابل للوصول؛ أعد محاولة التحقق من الجلسة." : "تعذر الوصول إلى خادم PowerHub حاليًا. لا يعني ذلك بالضرورة انقطاع الإنترنت."}</p><div className="mt-6 flex flex-wrap justify-center gap-3"><button type="button" onClick={() => { resetSupabaseSessionReadBackoff(); void refresh(); }} className="rounded-xl bg-[#F5B800] px-5 py-3 text-sm font-extrabold text-[#0D1117]">إعادة المحاولة واستعادة البيانات</button><button type="button" onClick={() => { window.location.assign("/login?forceLogin=1"); }} className="rounded-xl border border-white/15 px-5 py-3 text-sm font-bold text-slate-200">فتح تسجيل الدخول</button></div></div></main>;
  }

  if (loading || shouldRedirectToLogin || shouldRedirectUnauthorized) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ توجيهك إلى المساحة المناسبة…</h1><p className="mt-2 text-sm text-slate-400">سجّل الدخول أولاً للوصول إلى واجهات التشغيل والصلاحيات الخاصة بحسابك.</p></div></main>;
  }

  if (user && user.role !== "admin") {
    const permittedPage = <TenantPermissionRouteGate>{children}</TenantPermissionRouteGate>;
    if (multiBranchOnly) return <MultiBranchRouteGate>{permittedPage}</MultiBranchRouteGate>;
    if (featureKey) return <TenantFeatureAccessGate featureKey={featureKey}>{permittedPage}</TenantFeatureAccessGate>;
    return permittedPage;
  }
  return <>{children}</>;
}

/**
 * A page-level permission barrier, not just sidebar filtering. The resolver
 * is server-authoritative and revalidates the active user + branch. Never
 * mount a disallowed page (whose queries might otherwise request its data).
 * Business RPCs retain their independent mandatory authorization checks.
 */
function TenantPermissionRouteGate({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user } = useAuth();
  const sites = trpc.powerhub.sites.list.useQuery(undefined, {
    refetchOnMount: "always", refetchOnWindowFocus: true, refetchOnReconnect: true,
  });
  const { branchId } = useBranchFilter(sites.data);
  const siteId = sites.data?.find((site) => site.id === branchId)?.id ?? sites.data?.[0]?.id ?? 0;
  const access = trpc.powerhub.staff.myAccess.useQuery({ siteId }, {
    enabled: siteId > 0,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchOnMount: "always", refetchOnWindowFocus: true, refetchOnReconnect: true,
  });
  const isDocumentationRoute = location === "/payment-documentation" ||
    location === "/payment-documentation/review";
  const paymentDocumentation = trpc.powerhub.paymentDocumentation.access.useQuery(
    { siteId },
    { enabled: siteId > 0 && isDocumentationRoute, staleTime: 0,
      refetchOnMount: "always", refetchOnReconnect: true },
  );
  // Cached TanStack Query / DashboardLayout initialData is not a fresh permission
  // decision. Wait for a server response after this page gate mounts before
  // rendering child routes, including after a branch or user switch.
  const accessVerified = access.isFetchedAfterMount === true;
  const documentationVerified = !isDocumentationRoute ||
    paymentDocumentation.isFetchedAfterMount === true;
  const ready = Boolean(!sites.isPending && !sites.isError && siteId &&
    !access.isPending && !access.isError && access.data && accessVerified);
  const allowed = ready && tenantMenuRouteAllowed(
    location, access.data?.role, access.data?.permissions,
    access.data?.usesPermissionOverride,
  ) && (!isDocumentationRoute || (documentationVerified &&
    paymentDocumentation.data?.allowed === true && !paymentDocumentation.isError));
  const fallback = access.data && firstPermittedTenantRoute(
    access.data.role, access.data.permissions, access.data.usesPermissionOverride,
  );

  useEffect(() => {
    // Login currently targets /workspace. Send constrained E47 staff to their
    // first actual operation instead of displaying a dashboard they cannot use.
    if (ready && !allowed && location === "/workspace" && fallback &&
      fallback !== location && !isDocumentationRoute) setLocation(fallback);
  }, [ready, allowed, location, fallback, isDocumentationRoute, setLocation]);

  if (sites.isPending || (siteId > 0 && (access.isPending || (!access.isError && !accessVerified))) ||
      (isDocumentationRoute && (paymentDocumentation.isPending ||
        (!paymentDocumentation.isError && !documentationVerified)))) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] text-slate-200" role="status" dir="rtl">جارٍ التحقق من صلاحيات الصفحة…</main>;
  }
  if (!ready || (isDocumentationRoute && paymentDocumentation.isError)) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" role="alert" dir="rtl">
      <div><h1 className="text-lg font-bold text-white">تعذر التحقق من الصلاحيات</h1>
      <p className="mt-3 text-sm text-slate-300">لم تُفتح الصفحة دون تحقق موثوق من صلاحيات الحساب والفرع.</p>
      <button type="button" className="mt-5 rounded-xl bg-[#F5B800] px-5 py-3 text-sm font-bold text-[#0D1117]"
        onClick={() => { void sites.refetch(); if (siteId) { void access.refetch(); if (isDocumentationRoute) void paymentDocumentation.refetch(); } }}>إعادة التحقق</button></div>
    </main>;
  }
  if (!allowed) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" role="alert" dir="rtl">
      <div><h1 className="text-lg font-bold text-white">هذه الصفحة ليست ضمن صلاحيات حسابك</h1>
      <p className="mt-3 text-sm text-slate-300">يمكن لصاحب المولد تعديل صلاحياتك وفق نطاق الفرع المخصص.</p>
      {fallback && fallback !== location && <button type="button"
        onClick={() => setLocation(fallback)}
        className="mt-5 rounded-xl bg-[#F5B800] px-5 py-3 text-sm font-bold text-[#0D1117]">فتح القسم المصرح به</button>}</div>
    </main>;
  }
  return <>{children}</>;
}

function TenantFeatureAccessGate({
  featureKey,
  children,
}: {
  featureKey: "support_chat" | "powerhub_ai_assistant";
  children: React.ReactNode;
}) {
  const featureSites = trpc.powerhub.sites.list.useQuery(undefined, {
    refetchOnMount: "always",
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const { branchId: selectedBranchId } = useBranchFilter(featureSites.data);
  const featureSiteId =
    featureSites.data?.find((site) => site.id === selectedBranchId)?.id ??
    featureSites.data?.[0]?.id ??
    0;
  const featureAccess = trpc.powerhub.staff.myFeatureAccess.useQuery(
    { siteId: featureSiteId },
    {
      enabled: featureSiteId > 0,
      refetchOnMount: "always",
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
    },
  );

  if (featureSites.isLoading || (featureSiteId > 0 && featureAccess.isLoading)) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ التحقق من إتاحة الميزة…</h1></div></main>;
  }
  if (featureSites.isError || featureAccess.isError || !featureSiteId || !featureAccess.data) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div className="max-w-md"><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">تعذر التحقق من إتاحة الميزة</h1><p className="mt-2 text-sm leading-7 text-slate-400">لم نتمكن من التحقق من سياسة الاشتراك من الخادم. لن نفتح هذه الصفحة اعتمادًا على بيانات مخزنة قديمة.</p><button type="button" onClick={() => { void featureSites.refetch(); if (featureSiteId) void featureAccess.refetch(); }} className="mt-5 rounded-xl bg-[#F5B800] px-5 py-3 text-sm font-extrabold text-[#0D1117]">إعادة التحقق</button></div></main>;
  }
  if (featureAccess.data[featureKey] !== true) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div className="max-w-md"><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">الميزة غير متاحة لهذا الاشتراك</h1><p className="mt-2 text-sm leading-7 text-slate-400">تم إيقاف الوصول إلى هذه الميزة وفق إعدادات المنصة أو الباقة أو التحكم الخاص بمساحة العمل.</p><button type="button" onClick={() => window.location.assign("/workspace")} className="mt-5 rounded-xl border border-white/15 px-5 py-3 text-sm font-bold text-slate-200">العودة إلى لوحة العمل</button></div></main>;
  }
  return <>{children}</>;
}

function MultiBranchRouteGate({children}:{children:React.ReactNode}) {
  const sites=trpc.powerhub.sites.list.useQuery(undefined,{
    refetchOnMount:"always",refetchOnReconnect:true,refetchOnWindowFocus:true,
  });
  const {branchId}=useBranchFilter(sites.data);
  const siteId=sites.data?.find(site=>site.id===branchId)?.id??sites.data?.[0]?.id??0;
  const entitlement=trpc.powerhub.sites.multiBranchAccess.useQuery({siteId},{
    enabled:siteId>0,refetchOnMount:"always",refetchOnReconnect:true,
    refetchOnWindowFocus:true,
  });
  if(sites.isLoading || entitlement.isLoading || entitlement.isFetching) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] text-slate-200" dir="rtl">جارٍ التحقق من إتاحة الخدمة…</main>;
  }
  // Never disclose the multi-site workspace on stale/offline/denied eligibility.
  if(sites.isError || entitlement.isError || !siteId ||
     entitlement.data?.siteId!==siteId || entitlement.data?.enabled!==true) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl">
      <div className="max-w-md">
        <h1 className="text-lg font-bold text-white">هذه الصفحة غير متاحة لهذا الاشتراك</h1>
        <button type="button" onClick={()=>window.location.assign("/workspace")}
          className="mt-5 rounded-xl border border-white/15 px-5 py-3 text-sm font-bold text-slate-200">العودة إلى لوحة العمل</button>
      </div>
    </main>;
  }
  return <>{children}</>;
}
