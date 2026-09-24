import { useAuth } from "@/_core/hooks/useAuth";
import { useEffect } from "react";
import { useLocation } from "wouter";

type RouteAccessGateProps = {
  children: React.ReactNode;
  platformAdminOnly?: boolean;
  supportOnly?: boolean;
  financeAdminOnly?: boolean;
};

export function RouteAccessGate({ children, platformAdminOnly = false, supportOnly = false, financeAdminOnly = false }: RouteAccessGateProps) {
  const { user, isAuthenticated, loading } = useAuth();
  const [, setLocation] = useLocation();
  const isPlatformAdmin = user?.role === "admin" && ["platform_owner", "platform_admin"].includes(user.platformRole ?? "");
  const isPlatformSupport = user?.role === "admin" && user.platformRole === "platform_support";
  const isFinanceAdmin = user?.role === "admin" && user.platformRole === "finance_admin";
  const shouldRedirectToLogin = !loading && !isAuthenticated;
  const shouldRedirectUnauthorized = !loading && isAuthenticated && ((platformAdminOnly && !isPlatformAdmin) || (financeAdminOnly && !isFinanceAdmin) || (supportOnly && !isPlatformSupport));

  useEffect(() => {
    if (shouldRedirectToLogin) setLocation("/login");
    else if (shouldRedirectUnauthorized) setLocation("/");
  }, [setLocation, shouldRedirectToLogin, shouldRedirectUnauthorized]);

  if (loading || shouldRedirectToLogin || shouldRedirectUnauthorized) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ توجيهك إلى المساحة المناسبة…</h1><p className="mt-2 text-sm text-slate-400">سجّل الدخول أولاً للوصول إلى واجهات التشغيل والصلاحيات الخاصة بحسابك.</p></div></main>;
  }

  return <>{children}</>;
}
