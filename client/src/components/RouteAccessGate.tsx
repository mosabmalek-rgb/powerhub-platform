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

type RouteAccessGateProps = {
  children: React.ReactNode;
  platformAdminOnly?: boolean;
  supportOnly?: boolean;
  financeAdminOnly?: boolean;
  featureKey?: "support_chat" | "powerhub_ai_assistant";
};

export function RouteAccessGate({ children, platformAdminOnly = false, supportOnly = false, financeAdminOnly = false, featureKey }: RouteAccessGateProps) {
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

  if (featureCheckRequired && (featureSites.isLoading || (featureSiteId > 0 && featureAccess.isLoading))) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ التحقق من إتاحة الميزة…</h1></div></main>;
  }
  if (featureCheckRequired && (featureSites.isError || featureAccess.isError || !featureSiteId || !featureAccess.data)) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div className="max-w-md"><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">تعذر التحقق من إتاحة الميزة</h1><p className="mt-2 text-sm leading-7 text-slate-400">لم نتمكن من التحقق من سياسة الاشتراك من الخادم. لن نفتح هذه الصفحة اعتمادًا على بيانات مخزنة قديمة.</p><button type="button" onClick={() => { void featureSites.refetch(); if (featureSiteId) void featureAccess.refetch(); }} className="mt-5 rounded-xl bg-[#F5B800] px-5 py-3 text-sm font-extrabold text-[#0D1117]">إعادة التحقق</button></div></main>;
  }
  if (featureCheckRequired && featureKey && featureAccess.data?.[featureKey] !== true) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div className="max-w-md"><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">الميزة غير متاحة لهذا الاشتراك</h1><p className="mt-2 text-sm leading-7 text-slate-400">تم إيقاف الوصول إلى هذه الميزة وفق إعدادات المنصة أو الباقة أو التحكم الخاص بمساحة العمل.</p><button type="button" onClick={() => setLocation("/workspace")} className="mt-5 rounded-xl border border-white/15 px-5 py-3 text-sm font-bold text-slate-200">العودة إلى لوحة العمل</button></div></main>;
  }

  if (featureKey && user && user.role !== "admin") {
    return <TenantFeatureAccessGate featureKey={featureKey}>{children}</TenantFeatureAccessGate>;
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
