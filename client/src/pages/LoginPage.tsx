import { PowerHubLogo } from "@/components/PowerHubLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getValidOfflineAuthLease } from "@/lib/offline-auth";
import { getOfflineAuthUser } from "@/lib/offline-query-cache";
import { getSupabaseSession, supabase } from "@/lib/supabase";
import { ArrowRight, KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { useLocation } from "wouter";

function authMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "تعذر إتمام العملية، حاول مرة أخرى.";
  if (/invalid login credentials/i.test(message)) return "البريد الإلكتروني أو كلمة المرور غير صحيحين.";
  if (/email not confirmed/i.test(message)) return "يرجى تأكيد البريد الإلكتروني من الرسالة المرسلة قبل تسجيل الدخول.";
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "لا يوجد اتصال بالإنترنت. إذا كانت جلستك السابقة ما تزال محفوظة على هذا الجهاز، أعد فتح PowerHub وسيتم الدخول تلقائيًا. أما تسجيل الدخول بعد تسجيل الخروج فيتطلب اتصالًا بالإنترنت.";
  }
  return message;
}

function isBrowserOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    void getSupabaseSession()
      .then(async (session) => {
        if (!active) return;
        if (session) {
          // A persisted, still-valid Supabase session is the trusted sign-in state
          // for this device. Reuse it instead of forcing a network login.
          window.location.replace("/workspace");
          return;
        }

        // A local lease is a fallback for offline use only. When online, keep
        // the form available so the user can establish a fresh Supabase session.
        if (!isBrowserOffline()) return;
        const lease = await getValidOfflineAuthLease();
        if (!active || !lease) return;
        const cachedUser = await getOfflineAuthUser(lease.userId);
        if (active && cachedUser) window.location.replace("/workspace");
      })
      .catch(() => {
        // Offline with no usable persisted session or lease: remain on the login form.
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
      const existingSession = await getSupabaseSession().catch(() => null);
      if (existingSession) {
        window.location.assign("/workspace");
        return;
      }

      // Never let a cached offline lease bypass a real password login while
      // the browser is online. Otherwise a stale lease can create a
      // /login -> /workspace -> /login redirect loop.
      if (isBrowserOffline()) {
        const offlineLease = await getValidOfflineAuthLease();
        if (offlineLease) {
          const cachedUser = await getOfflineAuthUser(offlineLease.userId);
          if (cachedUser) {
            window.location.assign("/workspace");
            return;
          }
        }
        throw new Error("لا يوجد اتصال بالإنترنت.");
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) throw signInError;
      const session = await getSupabaseSession();
      if (!session) throw new Error("تعذر تثبيت جلسة الدخول. حاول مرة أخرى.");
      // Use a full navigation after sign-in so the protected route boots from
      // the persisted Supabase session instead of racing React route state.
      window.location.assign("/workspace");
    } catch (submitError) {
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
          <div className="mt-12 flex items-center gap-3 text-sm text-slate-300"><ShieldCheck className="h-5 w-5 text-emerald-400" />جلسة محمية عبر Supabase Auth</div>
        </section>
        <section className="relative mx-auto w-full max-w-md rounded-[28px] border border-[#dbe3ec] bg-white p-6 shadow-2xl shadow-slate-900/15 sm:p-8">
          <button onClick={() => setLocation("/")} className="mb-8 flex items-center gap-2 text-sm font-bold text-slate-400 transition hover:text-[#F5B800]"><ArrowRight className="h-4 w-4" />العودة للصفحة الرئيسية</button>
          <div className="lg:hidden"><button type="button" onClick={() => setLocation("/")} className="rounded-lg transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800] focus-visible:ring-offset-4" aria-label="العودة إلى الصفحة الرئيسية عبر شعار PowerHub"><PowerHubLogo className="scale-[1.35] origin-right sm:scale-[1.55]" /></button><div className="mt-8" /></div>
          <p className="text-sm font-bold text-[#F5B800]">حساب PowerHub</p>
          <h2 className="mt-2 text-2xl font-extrabold">تسجيل الدخول</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">أدخل بريدك وكلمة المرور للوصول إلى المساحة المصرح بها.</p>
          <form className="mt-7 space-y-5" onSubmit={submit}>
            <div className="space-y-2"><Label htmlFor="email" className="text-[#263546]">البريد الإلكتروني</Label><div className="relative"><Mail className="absolute right-3 top-3 h-4 w-4 text-slate-500" /><Input id="email" type="email" autoComplete="email" dir="ltr" value={email} onChange={(event) => setEmail(event.target.value)} required className="h-11 border-[#d5dee8] bg-[#f8fafc] pr-10 text-[#17212b] placeholder:text-slate-400" placeholder="you@example.com" /></div></div>
            <div className="space-y-2"><Label htmlFor="password" className="text-[#263546]">كلمة المرور</Label><div className="relative"><KeyRound className="absolute right-3 top-3 h-4 w-4 text-slate-500" /><Input id="password" type="password" autoComplete="current-password" dir="ltr" value={password} onChange={(event) => setPassword(event.target.value)} required className="h-11 border-[#d5dee8] bg-[#f8fafc] pr-10 text-[#17212b] placeholder:text-slate-400" placeholder="••••••••" /></div></div>
            {error && <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm leading-6 text-rose-700">{error}</p>}
            <Button disabled={pending} type="submit" className="h-11 w-full bg-[#F5B800] font-extrabold text-[#0D1117] hover:bg-[#ffd23f]">{pending ? <><Loader2 className="ml-2 h-4 w-4 animate-spin" />جارٍ المتابعة…</> : "تسجيل الدخول"}</Button>
          </form>
          <p className="mt-6 rounded-xl border border-[#dbe3ec] bg-[#f8fafc] px-4 py-3 text-center text-xs leading-6 text-[#536477]">تُنشأ الحسابات ودعوات الوصول من إدارة PowerHub أو لوحة Supabase. إن لم يكن لديك حساب، تواصل مع إدارة المنصة.</p>
        </section>
      </div>
    </main>
  );
}
