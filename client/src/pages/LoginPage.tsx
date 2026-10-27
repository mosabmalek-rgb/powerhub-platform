import { useAuth } from "@/_core/hooks/useAuth";
import { PowerHubLogo } from "@/components/PowerHubLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getValidOfflineAuthLease } from "@/lib/offline-auth";
import { getOfflineAuthUser } from "@/lib/offline-query-cache";
import { resetSupabaseSessionReadBackoff, supabase } from "@/lib/supabase";
import { probePowerHubConnectivity } from "@/lib/offline-connectivity";
import { shouldRedirectToWorkspaceAfterAuthentication } from "@/lib/auth-routing";
import { describeAuthFailure } from "@/lib/auth-diagnostics";
import { ArrowRight, KeyRound, Loader2, Mail } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { useLocation } from "wouter";

function authMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "تعذر إتمام العملية، حاول مرة أخرى.";
  if (/invalid login credentials/i.test(message)) return "البريد الإلكتروني أو كلمة المرور غير صحيحين.";
  if (/email not confirmed/i.test(message)) return "يرجى تأكيد البريد الإلكتروني من الرسالة المرسلة قبل تسجيل الدخول.";
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "تعذر الوصول إلى خدمة الدخول أو خادم PowerHub مؤقتًا. هذا لا يثبت انقطاع الإنترنت عن جهازك؛ تحقق من الاتصال بالخادم ثم أعد المحاولة.";
  }
  return message;
}

function isBrowserOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const {
    isAuthenticated,
    loading: authLoading,
    hasSession: hasSupabaseSession,
    error: authError,
    refresh,
    powerHubReachable,
  } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // A session snapshot alone is not server validation. Navigating to
    // /workspace merely because hasSession=true causes a loop when the
    // workspace correctly refuses an unvalidated session and returns to /login.
    if (shouldRedirectToWorkspaceAfterAuthentication({
      loading: authLoading,
      isAuthenticated,
    })) setLocation("/workspace");
  }, [authLoading, isAuthenticated, setLocation]);

  useEffect(() => {
    let active = true;

    const restoreOfflineWorkspace = async () => {
      // navigator.onLine is only a hint and may stay true when Wi-Fi/VPN/DNS
      // is broken. Probe the actual PowerHub origin on login-page mount so a
      // previously validated offline lease can restore cached read-only work.
      // This probe is background-only and never blocks the password form.
      const reachable = await probePowerHubConnectivity();
      if (!active || reachable) return;

      const lease = await getValidOfflineAuthLease();
      if (!active || !lease) return;
      const cachedUser = await getOfflineAuthUser(lease.userId);
      if (active && cachedUser) window.location.replace("/workspace");
    };

    void restoreOfflineWorkspace().catch(() => {
      // Keep the password form usable if browser storage or connectivity checks fail.
    });

    return () => {
      active = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      // The browser can report offline while this origin is reachable. Confirm
      // the application server before deciding to use the offline lease path.
      if (isBrowserOffline() && !(await probePowerHubConnectivity())) {
        const offlineLease = await getValidOfflineAuthLease();
        if (offlineLease) {
          const cachedUser = await getOfflineAuthUser(offlineLease.userId);
          if (cachedUser) {
            setLocation("/workspace");
            return;
          }
        }
        throw new Error("لا يوجد اتصال بالإنترنت.");
      }

      // Do not skip credential validation just because local storage contains a
      // session. signInWithPassword must be allowed to replace stale/revoked state.
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) throw signInError;
      if (!data.session) throw new Error("تعذر تثبيت جلسة الدخول. حاول مرة أخرى.");

      // The sign-in response itself contains the newly-created session. Avoid a
      // second shared session read here, which may still hold an older snapshot.
      setLocation("/workspace");
    } catch (submitError) {
      const networkFailure = submitError instanceof TypeError ||
        /failed to fetch|networkerror|network request failed|load failed|fetch failed|network.*(?:unavailable|offline)|connection (?:lost|reset|refused)|timeout/i.test(
          submitError instanceof Error ? submitError.message : String(submitError ?? ""),
        );
      // navigator.onLine can remain true while DNS, the API, or Supabase is
      // unreachable. Fall back to the previously validated device lease only
      // for network failures, never for invalid credentials or authorization errors.
      if (networkFailure) {
        const offlineLease = await getValidOfflineAuthLease();
        if (offlineLease) {
          const cachedUser = await getOfflineAuthUser(offlineLease.userId);
          if (cachedUser) {
            setLocation("/workspace");
            return;
          }
        }
      }
      setError(authMessage(submitError));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="min-h-screen overflow-hidden bg-[#f5f7fb] text-[#17212b]" dir="rtl">
      <div className="relative mx-auto grid min-h-screen max-w-6xl items-center gap-12 px-5 py-10 lg:grid-cols-[1.1fr_.9fr]">
        <div className="pointer-events-none absolute inset-0 opacity-30" style={{ backgroundImage: "linear-gradient(rgba(245,184,0,.12) 1px, transparent 1px), linear-gradient(90deg, rgba(245,184,0,.07) 1px, transparent 1px)", backgroundSize: "52px 52px" }} />
        <section className="relative hidden lg:block">
          <button type="button" onClick={() => setLocation("/")} className="rounded-lg transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800] focus-visible:ring-offset-4" aria-label="العودة إلى الصفحة الرئيسية عبر شعار PowerHub">
            <PowerHubLogo className="scale-[1.55] origin-right lg:scale-[1.9]" />
          </button>
          <p className="mt-14 text-sm font-bold text-[#F5B800]">إدارة الطاقة بذكاء</p>
          <h1 className="mt-4 max-w-xl text-5xl font-extrabold leading-[1.25]">مساحتك الآمنة لإدارة التشغيل والتحصيل.</h1>
          <p className="mt-6 max-w-lg text-base leading-8 text-slate-400">تسجّل الدخول بحسابك الشخصي، ثم يفتح PowerHub تلقائياً مساحة المنصة أو المولد والصلاحيات المرتبطة بك.</p>
        </section>
        <section className="relative mx-auto w-full max-w-md rounded-[28px] border border-[#dbe3ec] bg-white p-6 shadow-2xl shadow-slate-900/15 sm:p-8">
          <button onClick={() => setLocation("/")} className="mb-8 flex items-center gap-2 text-sm font-bold text-slate-400 transition hover:text-[#F5B800]"><ArrowRight className="h-4 w-4" />العودة للصفحة الرئيسية</button>
          <div className="lg:hidden"><button type="button" onClick={() => setLocation("/")} className="rounded-lg transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800] focus-visible:ring-offset-4" aria-label="العودة إلى الصفحة الرئيسية عبر شعار PowerHub"><PowerHubLogo className="scale-[1.35] origin-right sm:scale-[1.55]" /></button><div className="mt-8" /></div>
          <p className="text-sm font-bold text-[#F5B800]">حساب PowerHub</p>
          <h2 className="mt-2 text-2xl font-extrabold">تسجيل الدخول</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">أدخل بريدك وكلمة المرور للوصول إلى المساحة المصرح بها.</p>
          {hasSupabaseSession && !isAuthenticated ? (
            <div role="status" aria-live="polite" className="mt-5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-sm leading-6 text-amber-900">
              <p className="font-bold text-amber-800">
                {authLoading ? "جارٍ التحقق من الجلسة المحفوظة…" : "الجلسة موجودة، لكن التحقق من الحساب لم يكتمل."}
              </p>
              <p className="mt-1 text-xs text-amber-800">
                {authError
                  ? describeAuthFailure(authError)
                  : powerHubReachable
                    ? "لم نعتمد الجلسة بعد. أعد المحاولة؛ لن نعيد التوجيه تلقائيًا قبل اكتمال التحقق."
                    : "تعذر الوصول إلى خادم PowerHub حاليًا. هذا لا يعني بالضرورة انقطاع الإنترنت، ولن نمسح الجلسة أو بيانات العمل."}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={authLoading}
                onClick={() => {
                  resetSupabaseSessionReadBackoff();
                  void refresh();
                }}
                className="mt-3 border-amber-700/30 text-amber-900"
              >
                {authLoading ? "جارٍ التحقق…" : "إعادة التحقق من الجلسة"}
              </Button>
            </div>
          ) : null}
          <form className="mt-7 space-y-5" onSubmit={submit}>
            <div className="space-y-2"><Label htmlFor="email" className="text-[#263546]">البريد الإلكتروني</Label><div className="relative"><Mail className="absolute right-3 top-3 h-4 w-4 text-slate-500" /><Input id="email" type="email" autoComplete="email" dir="ltr" value={email} onChange={(event) => setEmail(event.target.value)} required className="h-11 border-[#d5dee8] bg-[#f8fafc] pr-10 text-[#17212b] placeholder:text-slate-400" placeholder="you@example.com" /></div></div>
            <div className="space-y-2"><Label htmlFor="password" className="text-[#263546]">كلمة المرور</Label><div className="relative"><KeyRound className="absolute right-3 top-3 h-4 w-4 text-slate-500" /><Input id="password" type="password" autoComplete="current-password" dir="ltr" value={password} onChange={(event) => setPassword(event.target.value)} required className="h-11 border-[#d5dee8] bg-[#f8fafc] pr-10 text-[#17212b] placeholder:text-slate-400" placeholder="••••••••" /></div></div>
            {error && <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm leading-6 text-rose-700">{error}</p>}
            <Button disabled={pending} type="submit" className="h-11 w-full bg-[#F5B800] font-extrabold text-[#0D1117] hover:bg-[#ffd23f]">{pending ? <><Loader2 className="ml-2 h-4 w-4 animate-spin" />جارٍ المتابعة…</> : "تسجيل الدخول"}</Button>
          </form>
        </section>
      </div>
    </main>
  );
}
