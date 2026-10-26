import { useAuth } from "@/_core/hooks/useAuth";
import { describeAuthFailure } from "@/lib/auth-diagnostics";
import { resetSupabaseSessionReadBackoff } from "@/lib/supabase";
import { useEffect } from "react";
import { useLocation } from "wouter";

type RouteAccessGateProps = {
  children: React.ReactNode;
  platformAdminOnly?: boolean;
  supportOnly?: boolean;
  financeAdminOnly?: boolean;
};

export function RouteAccessGate({ children, platformAdminOnly = false, supportOnly = false, financeAdminOnly = false }: RouteAccessGateProps) {
  const { user, isAuthenticated, loading, error, logout, refresh } = useAuth();
  const [, setLocation] = useLocation();
  const isPlatformAdmin = user?.role === "admin" && ["platform_owner", "platform_admin"].includes(user.platformRole ?? "");
  const isPlatformSupport = user?.role === "admin" && user.platformRole === "platform_support";
  const isFinanceAdmin = user?.role === "admin" && user.platformRole === "finance_admin";
  const authCheckFailed = !loading && Boolean(error) && !user;
  const shouldRedirectToLogin = !loading && !isAuthenticated && !authCheckFailed;
  const shouldRedirectUnauthorized = !loading && isAuthenticated && ((platformAdminOnly && !isPlatformAdmin) || (financeAdminOnly && !isFinanceAdmin) || (supportOnly && !isPlatformSupport));

  useEffect(() => {
    if (shouldRedirectToLogin) setLocation("/login");
    else if (shouldRedirectUnauthorized) setLocation("/");
  }, [setLocation, shouldRedirectToLogin, shouldRedirectUnauthorized]);

  if (authCheckFailed) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div className="max-w-md"><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">تعذر التحقق من الجلسة</h1><p className="mt-2 text-sm leading-7 text-slate-400">قد تكون الجلسة موجودة لكن تعذر التحقق منها مؤقتًا. أعد المحاولة قبل تسجيل الخروج حتى لا تفقد حالة العمل الحالية.</p><p role="status" aria-live="polite" className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-6 text-slate-300">{describeAuthFailure(error)}</p><div className="mt-6 flex flex-wrap justify-center gap-3"><button type="button" onClick={() => { resetSupabaseSessionReadBackoff(); void refresh(); }} className="rounded-xl bg-[#F5B800] px-5 py-3 text-sm font-extrabold text-[#0D1117]">إعادة المحاولة واستعادة البيانات</button><button type="button" onClick={() => void logout()} className="rounded-xl border border-white/15 px-5 py-3 text-sm font-bold text-slate-200">تسجيل الخروج</button></div></div></main>;
  }

  if (loading || shouldRedirectToLogin || shouldRedirectUnauthorized) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ توجيهك إلى المساحة المناسبة…</h1><p className="mt-2 text-sm text-slate-400">سجّل الدخول أولاً للوصول إلى واجهات التشغيل والصلاحيات الخاصة بحسابك.</p></div></main>;
  }

  return <>{children}</>;
}
