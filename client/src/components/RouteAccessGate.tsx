import { useAuth } from "@/_core/hooks/useAuth";
import { useEffect } from "react";
import { useLocation } from "wouter";

type RouteAccessGateProps = {
  children: React.ReactNode;
  platformAdminOnly?: boolean;
};

export function RouteAccessGate({ children, platformAdminOnly = false }: RouteAccessGateProps) {
  const { user, isAuthenticated, loading } = useAuth();
  const [, setLocation] = useLocation();
  const shouldRedirect = !loading && (!isAuthenticated || (platformAdminOnly && user?.role !== "admin"));

  useEffect(() => {
    if (shouldRedirect) setLocation("/");
  }, [setLocation, shouldRedirect]);

  if (loading || shouldRedirect) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ توجيهك إلى المساحة المناسبة…</h1><p className="mt-2 text-sm text-slate-400">سجّل الدخول أولاً للوصول إلى واجهات التشغيل والصلاحيات الخاصة بحسابك.</p></div></main>;
  }

  return <>{children}</>;
}
