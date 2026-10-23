import { PowerHubLogo } from "@/components/PowerHubLogo";
import { ThemeSelector } from "@/components/ThemeSelector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  BarChart3,
  BellRing,
  Bolt,
  Check,
  ChevronLeft,
  FileText,
  Gauge,
  Landmark,
  MessageSquareText,
  ReceiptText,
  ShieldCheck,
  UsersRound,
  WalletCards,
  Zap,
} from "lucide-react";
import { useLocation } from "wouter";

const features = [
  { icon: UsersRound, title: "إدارة المشتركين والعدادات", text: "ملف واضح لكل مشترك، وعداداته وقراءاته وحالة الخدمة ضمن سجل منظم." },
  { icon: Gauge, title: "قراءة وفوترة مترابطة", text: "حوّل القراءة المعتمدة إلى استهلاك وفاتورة وفق التعرفة ودورة الفوترة المعتمدة." },
  { icon: ReceiptText, title: "فاتورة قابلة للمشاركة", text: "شارك الفاتورة عبر رابط خاص بها، من دون كشف بيانات بقية المشتركين." },
  { icon: WalletCards, title: "تحصيل وأرصدة أوضح", text: "سجّل الدفعات الجزئية والكاملة، وتابع الرصيد المتبقي وحركة الحسابات." },
  { icon: BarChart3, title: "تقارير تساعدك على القرار", text: "تابع الفوترة والتحصيل والمتأخرات والمصروفات وأداء العمل من مؤشرات مترابطة." },
  { icon: ShieldCheck, title: "صلاحيات وسجل تدقيق", text: "افصل بيانات كل مساحة، وحدد صلاحيات الفريق، وراجع العمليات الحساسة المسجلة." },
  { icon: BellRing, title: "مركز رسائل وتذكيرات", text: "نظّم رسائل الفواتير والتذكير، وتابع حالات الإرسال من مركز واحد عند تفعيل القنوات." },
  { icon: Landmark, title: "إدارة الفروع والمولدات", text: "نظّم محطاتك ومولداتك وتعرفة الكهرباء ضمن مساحة قابلة للتوسع." },
];

const fallbackPlans = [
  {
    name: "الأساسية",
    description: "لبداية منظمة مع محطة تشغيل واحدة.",
    accent: "border-white/10 bg-white/[0.025]",
    items: ["حتى 150 مشترك", "المشتركون والعدادات", "القراءات والفوترة", "روابط الفواتير", "تقارير تشغيلية أساسية"],
    action: "ابدأ بمساحتك",
    price: 143,
    currency: "ILS",
  },
  {
    name: "الاحترافية",
    description: "للتشغيل اليومي الذي يحتاج تدقيقاً وتحليلاً أعمق.",
    accent: "border-[#F5B800]/55 bg-[#F5B800]/[0.055] shadow-[0_20px_70px_rgba(245,184,0,0.08)]",
    highlighted: true,
    items: ["حتى 500 مشترك", "كل ميزات الأساسية", "جلسات المحصل والإغلاق", "تقارير وتحليلات متقدمة", "إدارة فريق المحطة"],
    action: "اختر الاحترافية",
    price: 251,
    currency: "ILS",
  },
  {
    name: "الشركات",
    description: "لشبكات متعددة ومتابعة مركزية مخصصة.",
    accent: "border-white/10 bg-white/[0.025]",
    items: ["حتى 750 مشترك", "محطات ومولدات متعددة", "صلاحيات تشغيلية دقيقة", "مركز قيادة إداري", "تهيئة حسب نطاق العمل"],
    action: "تحدث إلينا",
    price: 323,
    currency: "ILS",
  },
];

function SectionTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <Badge className="border border-[#F5B800]/20 bg-[#F5B800]/10 px-3 py-1 text-xs font-bold text-[#F5B800] hover:bg-[#F5B800]/10">{eyebrow}</Badge>
      <h2 className="mt-5 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">{title}</h2>
      <p className="mt-4 text-base leading-8 text-slate-400 sm:text-lg">{description}</p>
    </div>
  );
}

export default function MarketingLandingPage() {
  const [, setLocation] = useLocation();
  const contact = trpc.platformContactSettings.public.useQuery(undefined, { staleTime: 60_000, retry: 1 });
  const whatsappNumber = String(contact.data?.whatsappNumber ?? "").replace(/\\D/g, "");
  const contactOnWhatsapp = () => { if (whatsappNumber) window.open(`https://wa.me/${whatsappNumber}`, "_blank", "noopener,noreferrer"); else document.getElementById("contact")?.scrollIntoView({ behavior: "smooth" }); };
  const catalog = trpc.powerhub.publicPackageCatalog.useQuery(undefined, { staleTime: 60_000, retry: 1 });
  // Fail open to the published default if the setting has not loaded yet.
  const showPlans = catalog.data?.showPlans !== false;
  const plans = catalog.data?.packages?.map((pkg, index) => ({
    name: String(pkg.name),
    description: `حل ${String(pkg.name)} لإدارة مشروع بيع الكهرباء بالكيلوواط.`,
    accent: index === 1 ? "border-[#F5B800]/55 bg-[#F5B800]/[0.055] shadow-[0_20px_70px_rgba(245,184,0,0.08)]" : "border-white/10 bg-white/[0.025]",
    highlighted: index === 1,
    items: [
      Number(pkg.includedSubscribers ?? 0) > 0
        ? ((pkg as Record<string, unknown>).subscribersLimitMode === "minimum"
          ? `ابتداءً من ${Number(pkg.includedSubscribers).toLocaleString("ar")} مشترك`
          : `حتى ${Number(pkg.includedSubscribers).toLocaleString("ar")} مشترك`)
        : "المشتركون والعدادات",
      `${Number(pkg.platformUsers ?? 0)} مستخدمو منصة`,
      `${Number(pkg.fieldUsers ?? 0)} مستخدمون ميدانيون`,
      `${Number(pkg.branches ?? 0)} فرع${Number(pkg.branches ?? 0) === 1 ? "" : "ان"}`,
    ],
    action: index === 1 ? "اختر الباقة" : "ابدأ بمساحتك",
    price: Number(pkg.price),
    currency: catalog.data?.currency ?? "ILS",
  })) ?? fallbackPlans;
  const goToFeatures = () => document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#0D1117] text-white" dir="rtl">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_83%_8%,rgba(245,184,0,0.13),transparent_25%),radial-gradient(circle_at_10%_22%,rgba(33,79,115,0.2),transparent_27%),linear-gradient(rgba(255,255,255,.026)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.026)_1px,transparent_1px)] bg-[length:auto,auto,44px_44px,44px_44px]" />

      <header className="ph-topbar-rail sticky top-0 z-30 border-b border-white/8 bg-[#0D1117]/85 backdrop-blur-xl">
        <div className="container flex min-h-[76px] flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2 lg:min-h-[92px] lg:flex-nowrap lg:py-0">
          <button type="button" className="shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800] focus-visible:ring-offset-4 focus-visible:ring-offset-[#0D1117]" onClick={() => setLocation("/")} aria-label="العودة إلى الصفحة الرئيسية عبر شعار PowerHub">
            <PowerHubLogo header marketing />
          </button>
          <nav className="hidden items-center gap-7 text-sm font-bold text-slate-300 xl:flex">
            <a href="#features" className="transition hover:text-[#F5B800]">المميزات</a>
            <a href="#how-it-works" className="transition hover:text-[#F5B800]">كيف تعمل</a>
            {showPlans ? <a href="#plans" className="transition hover:text-[#F5B800]">الباقات</a> : null}
            <a href="#contact" className="transition hover:text-[#F5B800]">تواصل</a>
          </nav>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <ThemeSelector compact />
            <Button variant="ghost" onClick={startLogin} className="inline-flex whitespace-nowrap border border-[#F5B800]/65 bg-white/35 px-3 text-sm font-bold text-[#7d5500] shadow-[0_5px_16px_rgba(151,100,0,.1)] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.02] hover:border-[#F5B800] hover:bg-[#F5B800]/10 hover:text-[#7d5500] hover:shadow-[0_10px_24px_rgba(191,132,0,.2)] active:translate-y-0 active:scale-[.97] motion-reduce:transform-none motion-reduce:transition-none dark:bg-white/5 dark:text-[#F5B800] dark:hover:text-[#F5B800] md:text-sm lg:px-4">تسجيل الدخول</Button>
            <Button onClick={contactOnWhatsapp} className="hidden whitespace-nowrap bg-[#F5B800] px-3 text-sm font-extrabold text-[#0D1117] shadow-[0_10px_32px_rgba(245,184,0,.2)] hover:bg-[#FFD45A] sm:inline-flex lg:px-4">اطلب بدء الاستخدام <ArrowLeft className="mr-2 h-4 w-4" /></Button>
          </div>
        </div>
      </header>

      <section className="container grid min-h-[650px] items-center gap-10 py-16 lg:grid-cols-[1.05fr_.95fr] lg:py-24">
        <div className="relative z-10 text-center lg:text-right">
          <Badge className="border border-[#F5B800]/20 bg-[#F5B800]/10 px-3 py-1.5 text-xs font-bold text-[#F5B800] hover:bg-[#F5B800]/10"><Bolt className="ml-1.5 h-3.5 w-3.5 fill-current" />منصة إدارة مولدات الكهرباء</Badge>
          <h1 className="mt-6 max-w-3xl text-4xl font-black leading-[1.18] tracking-tight text-white sm:text-5xl lg:text-6xl">
            كل <span className="text-[#F5B800]">كيلوواط تحت السيطرة.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-8 text-slate-300 sm:text-lg lg:mx-0">من قراءة العداد إلى الفاتورة والتحصيل، أدر مشروع الكهرباء من مكان واحد، وتابع المستحقات والعمليات بوضوح.</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row lg:justify-start">
            <Button size="lg" onClick={contactOnWhatsapp} className="h-12 bg-[#F5B800] px-6 text-base font-extrabold text-[#0D1117] hover:bg-[#FFD45A]">ابدأ إدارة مشروعك <ArrowLeft className="mr-2 h-5 w-5" /></Button>
            <Button size="lg" variant="outline" onClick={goToFeatures} className="h-12 border-white/15 bg-white/[0.025] px-6 text-base font-bold text-white hover:bg-white/8 hover:text-white">استكشف المميزات <ChevronLeft className="mr-1 h-5 w-5" /></Button>
          </div>
          <div className="mt-10 grid max-w-2xl grid-cols-3 gap-3 text-right">
            {[
              ["قراءة ← فاتورة", "تسلسل واضح من الاستهلاك إلى الفوترة"],
              ["تحصيل", "متابعة الدفعات والأرصدة المتبقية"],
              ["صلاحيات", "مساحة مستقلة لكل صاحب مولد"],
            ].map(([value, label]) => <div key={value} className="rounded-2xl border border-white/8 bg-white/[0.025] px-3 py-3"><p className="font-display text-lg font-extrabold text-[#F5B800]" dir="ltr">{value}</p><p className="mt-1 text-xs leading-5 text-slate-400">{label}</p></div>)}
          </div>
        </div>
          <div className="relative mx-auto w-full max-w-[650px]">
          <div className="absolute -inset-8 rounded-full bg-[#F5B800]/10 blur-3xl" />
          <div className="relative overflow-hidden rounded-[30px] border border-white/10 bg-[#111823] p-2 shadow-[0_28px_110px_rgba(0,0,0,.45)]">
            <div className="flex h-[420px] flex-col rounded-[23px] bg-[#0B1018] p-6" aria-label="لوحة تشغيل PowerHub">
              <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2 text-[11px] text-slate-500"><span>تصميم توضيحي لواجهة المنصة</span><span>لا يعرض بيانات تشغيل فعلية</span></div>
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-[#F5B800] text-[#0D1117]"><Bolt className="size-5 fill-current" /></span><div><p className="text-xs text-slate-400">معاينة توضيحية</p><p className="text-sm font-black text-white">ملخص دورة التشغيل</p></div></div>
                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-bold text-emerald-300">مستقرة</span>
              </div>
              <div className="grid flex-1 grid-cols-2 gap-3 py-5">
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><p className="text-xs font-bold text-slate-400">استهلاك الدورة</p><p className="mt-2 font-display text-3xl font-black text-[#F5B800]" dir="ltr">حسب القراءات المعتمدة</p><div className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full w-[71%] rounded-full bg-[#F5B800]" /></div></div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><p className="text-xs font-bold text-slate-400">التحصيل المسجل</p><p className="mt-2 font-display text-3xl font-black text-white" dir="ltr">متابعة الدفعات</p><div className="mt-5 flex items-end gap-1.5" aria-hidden="true"><i className="h-4 flex-1 rounded-t bg-[#F5B800]/35" /><i className="h-7 flex-1 rounded-t bg-[#F5B800]/55" /><i className="h-5 flex-1 rounded-t bg-[#F5B800]/45" /><i className="h-10 flex-1 rounded-t bg-[#F5B800]" /><i className="h-8 flex-1 rounded-t bg-[#F5B800]/70" /></div></div>
                <div className="col-span-2 flex items-center justify-between rounded-2xl border border-[#F5B800]/20 bg-[#F5B800]/[0.06] px-4 py-3"><div className="flex items-center gap-3"><Gauge className="size-5 text-[#F5B800]" /><div><p className="text-xs text-slate-400">آخر قراءة معتمدة</p><p className="mt-0.5 text-sm font-bold text-white">حالة القراءة</p></div></div><span className="font-display text-sm font-black text-[#F5B800]" dir="ltr">استهلاك محسوب</span></div>
              </div>
            </div>
            <div className="absolute inset-x-5 bottom-5 rounded-2xl border border-white/10 bg-[#0D1117]/80 p-4 shadow-lg backdrop-blur-md">
              <div className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold text-[#F5B800]">معاينة واجهة PowerHub</p><p className="mt-1 text-sm font-bold text-white">قراءة، فاتورة، تحصيل — في مسار واحد</p></div><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#F5B800] text-[#0D1117]"><Zap className="h-5 w-5 fill-current" /></span></div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="border-y border-white/8 bg-[#111823]/55 py-20 sm:py-24">
        <div className="container">
          <SectionTitle eyebrow="تشغيل أوضح" title="كل ما يحتاجه مشروع الكهرباء في مكان واحد" description="صممت PowerHub حول دورة التشغيل الفعلية للمولدات، لا حول جداول حسابية عامة." />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {features.map(({ icon: Icon, title, text }) => <article key={title} className="group rounded-2xl border border-white/8 bg-[#0D1117]/70 p-5 transition duration-200 hover:-translate-y-1 hover:border-[#F5B800]/40 hover:bg-[#0D1117]"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#F5B800]/10 text-[#F5B800] transition group-hover:bg-[#F5B800] group-hover:text-[#0D1117]"><Icon className="h-5 w-5" /></span><h3 className="mt-5 font-bold text-white">{title}</h3><p className="mt-2 text-sm leading-7 text-slate-400">{text}</p></article>)}
          </div>
        </div>
      </section>

      <section className="border-y border-white/8 bg-[#111823]/45 py-16 sm:py-20">
        <div className="container">
          <SectionTitle eyebrow="منظومة مترابطة" title="لا تكتفِ بعرض الأرقام؛ اعرف الخطوة التالية" description="صُممت الواجهة لتقودك من البيانات إلى الإجراء، مع إبقاء القرارات المالية المهمة قابلة للمراجعة." />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["01", "ما الذي صدر؟", "تابع القراءات والفواتير ضمن دورة العمل المحددة."],
              ["02", "ما الذي تم تحصيله؟", "راجع الدفعات والأرصدة المتبقية بدل جمعها يدويًا."],
              ["03", "ما الذي يحتاج متابعة؟", "ابدأ من المتأخرات والحالات التي تتطلب إجراءً."],
              ["04", "من نفّذ العملية؟", "استخدم الصلاحيات وسجل التدقيق لمراجعة العمليات الحساسة."],
            ].map(([number, title, text]) => <article key={number} className="rounded-2xl border border-white/8 bg-[#0D1117]/65 p-5"><span className="font-display text-sm font-black text-[#F5B800]" dir="ltr">{number}</span><h3 className="mt-3 font-bold text-white">{title}</h3><p className="mt-2 text-sm leading-7 text-slate-400">{text}</p></article>)}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="container py-20 sm:py-28">
        <SectionTitle eyebrow="بداية عملية" title="ثلاث خطوات لتشغيل أكثر وضوحاً" description="من إنشاء مساحة العمل إلى متابعة الدورة المالية، يظل تسلسل العمل مباشراً وآمناً." />
        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {[
            ["01", "أنشئ مساحة المولد", "سجّل الدخول وأنشئ محطتك الأولى ضمن مساحة صاحب مولد مستقلة."],
            ["02", "أضف الشبكة وابدأ القراءة", "نظّم المولدات والمشتركين والعدادات، ثم سجل القراءات ميدانياً أو من المكتب."],
            ["03", "فوّت وحصّل بثقة", "اعتمد القراءة، أصدر الفاتورة، تابع التحصيل والمصروفات من لوحة تشغيل واحدة."],
          ].map(([number, title, text]) => <article key={number} className="relative rounded-3xl border border-white/8 bg-[#111823] p-7"><div className="font-display text-5xl font-black text-[#F5B800]/30" dir="ltr">{number}</div><h3 className="mt-7 text-xl font-extrabold text-white">{title}</h3><p className="mt-3 text-sm leading-7 text-slate-400">{text}</p><div className="mt-7 flex h-9 w-9 items-center justify-center rounded-full border border-[#F5B800]/30 text-[#F5B800]"><Check className="h-4 w-4" /></div></article>)}
        </div>
      </section>

      {showPlans ? <section id="plans" className="border-y border-white/8 bg-[#111823]/55 py-20 sm:py-24">
        <div className="container">
          <SectionTitle eyebrow="نطاقات مرنة" title="باقة تناسب حجم تشغيلك" description="تُضبط خطة الاشتراك وفق عدد المحطات والمولدات ومتطلبات التشغيل؛ لا تعرض هذه الصفحة سعراً ثابتاً قبل تحديد نطاق العمل." />
          <div className="mx-auto mt-12 grid max-w-6xl gap-5 lg:grid-cols-3">
            {plans.map((plan) => <article key={plan.name} className={`relative rounded-3xl border p-6 ${plan.accent}`}>{plan.highlighted && <Badge className="absolute -top-3 right-6 bg-[#F5B800] px-3 py-1 text-[#0D1117] hover:bg-[#F5B800]">للعمليات النشطة</Badge>}<h3 className="text-2xl font-extrabold text-white">{plan.name}</h3><p className="mt-3 min-h-12 text-sm leading-6 text-slate-400">{plan.description}</p><p className="mt-4 text-3xl font-black text-[#F5B800]" dir="ltr">{Number(plan.price).toLocaleString("ar-IQ")} <span className="text-sm">{plan.currency === "ILS" ? "₪" : plan.currency}</span><span className="mr-1 text-xs font-normal text-slate-400">شهرياً</span></p><div className="my-6 h-px bg-white/8" /><ul className="space-y-3">{plan.items.map((item) => <li key={item} className="flex items-start gap-2 text-sm text-slate-200"><Check className="mt-0.5 h-4 w-4 shrink-0 text-[#F5B800]" />{item}</li>)}</ul><Button onClick={contactOnWhatsapp} variant={plan.highlighted ? "default" : "outline"} className={plan.highlighted ? "mt-8 w-full bg-[#F5B800] font-extrabold text-[#0D1117] hover:bg-[#FFD45A]" : "mt-8 w-full border-white/15 bg-white/[0.02] font-bold text-white hover:bg-white/8 hover:text-white"}>{plan.action}</Button></article>)}
          </div>
        </div>
      </section> : null}

      <section id="contact" className="container py-20 sm:py-28">
        <div className="relative overflow-hidden rounded-[32px] border border-[#F5B800]/30 bg-[#fff7dd] px-6 py-12 text-center text-[#17212b] shadow-[0_20px_70px_rgba(33,45,60,0.10)] dark:bg-gradient-to-l dark:from-[#1c2229] dark:to-[#111823] dark:text-white sm:px-12"><div className="absolute left-0 top-0 h-56 w-56 rounded-full bg-[#F5B800]/15 blur-3xl dark:bg-[#F5B800]/10" /><MessageSquareText className="relative mx-auto h-7 w-7 text-[#9a6800] dark:text-[#F5B800]" /><h2 className="relative mt-5 text-3xl font-extrabold text-[#17212b] dark:text-white sm:text-4xl">أدِر مشروع الكهرباء بوضوح أكبر.</h2><p className="relative mx-auto mt-4 max-w-2xl text-base leading-8 text-[#3f4c5a] dark:text-slate-300">من قراءة العداد إلى الفاتورة والتحصيل، اجعل تفاصيل التشغيل ومتابعة المستحقات في مساحة واحدة.</p><Button size="lg" onClick={contactOnWhatsapp} className="relative mt-8 bg-[#F5B800] px-7 font-extrabold text-[#0D1117] hover:bg-[#FFD45A]">تواصل لبدء الاستخدام <ArrowLeft className="mr-2 h-5 w-5" /></Button></div>
      </section>

      <footer className="border-t border-white/8 bg-[#090d12]">
        <div className="container flex flex-col gap-5 py-8 text-center sm:flex-row sm:items-center sm:justify-between sm:text-right"><button type="button" onClick={() => setLocation("/")} className="mx-auto rounded-lg transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800] focus-visible:ring-offset-4 focus-visible:ring-offset-[#090d12] sm:mx-0" aria-label="العودة إلى الصفحة الرئيسية عبر شعار PowerHub"><PowerHubLogo marketing /></button><p className="text-sm text-slate-500">PowerHub — إدارة الطاقة بذكاء.</p><div className="flex justify-center gap-5 text-sm font-bold text-slate-400"><a href="#features" className="hover:text-[#F5B800]">المميزات</a>{showPlans ? <a href="#plans" className="hover:text-[#F5B800]">الباقات</a> : null}<button onClick={startLogin} className="hover:text-[#F5B800]">تسجيل الدخول</button></div></div>
        <div className="container border-t border-white/8 px-4 py-4 text-center text-xs leading-6 text-slate-500">جميع الحقوق محفوظة لشركة SAIRO للخدمات الرقمية والتقنية</div>
      </footer>
    </main>
  );
}
