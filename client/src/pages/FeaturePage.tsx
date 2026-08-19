import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useLocation } from "wouter";
import {
  BellRing, Bolt, ChevronLeft, ClipboardList, Fuel, Gauge,
  MapPinned, ReceiptText, Settings2, ShieldCheck, UsersRound, WalletCards,
  Wrench, Zap,
} from "lucide-react";

const sections = {
  subscribers: {
    icon: UsersRound,
    eyebrow: "قاعدة العملاء",
    title: "إدارة المشتركين",
    description: "سجل مركزي لبيانات المشتركين، اشتراكاتهم، العدادات وحالة الخدمة.",
    action: "إضافة مشترك",
    checklist: ["الاسم ورقم الهاتف والعنوان", "سكني أو تجاري", "حالة الخدمة والرصيد", "ربط الاشتراك بالعداد والمنطقة"],
  },
  generators: {
    icon: Bolt,
    eyebrow: "التشغيل والطاقة",
    title: "المحطات والمولدات",
    description: "مراقبة قدرة المولدات والوقود وساعات التشغيل والصيانة في مكان واحد.",
    action: "إضافة مولد",
    checklist: ["القدرة الاسمية والتشغيلية", "حالة التشغيل الفعلية", "الوقود وساعات العمل", "الصيانة والتنبيهات"],
  },
  readings: {
    icon: Gauge,
    eyebrow: "القياس الميداني",
    title: "العدادات والقراءات",
    description: "تسجيل قراءة العداد يدوياً أو عبر التطبيق الميداني، مع صورة وتدقيق قبل الفوترة.",
    action: "قراءة جديدة",
    checklist: ["القراءة السابقة والحالية", "تصوير العداد وإرفاق الموقع", "حساب الاستهلاك تلقائياً", "مراجعة القراءات غير الطبيعية"],
  },
  invoices: {
    icon: ReceiptText,
    eyebrow: "الفوترة والتحصيل",
    title: "الفواتير والتعرفات",
    description: "إصدار فواتير حسب الكيلوواط/ساعة، مع الرسوم والضرائب ورابط مشاركة آمن.",
    action: "إنشاء فاتورة",
    checklist: ["تعرفة ثابتة أو شرائح", "بنود ورسوم وضرائب", "رابط فاتورة قابل للمشاركة", "حالة مدفوعة أو مستحقة"],
  },
  collections: {
    icon: WalletCards,
    eyebrow: "النقدية والمدفوعات",
    title: "التحصيلات والمدفوعات",
    description: "تسجيل الدفعات النقدية والإلكترونية ومطابقتها مع جلسات المحصلين.",
    action: "تسجيل دفعة",
    checklist: ["إيصالات برقم فريد", "توزيع الدفعات على الفواتير", "جلسات المحصلين والفروقات", "متابعة المتأخرات"],
  },
  expenses: {
    icon: Fuel,
    eyebrow: "التكلفة والربحية",
    title: "المصروفات والربحية",
    description: "سجل للوقود والصيانة والرواتب، مع مؤشرات الربح التشغيلي لكل محطة ومولد.",
    action: "إضافة مصروف",
    checklist: ["الوقود وقطع الغيار", "الصيانة والرواتب", "تكلفة الكيلوواط المباع", "صافي الربح التشغيلي"],
  },
  reports: {
    icon: ClipboardList,
    eyebrow: "الرؤية والتحليل",
    title: "التقارير والتحليلات",
    description: "تقارير يومية وشهرية عن الاستهلاك والإيرادات والفاقد والديون وأداء المحصلين.",
    action: "إنشاء تقرير",
    checklist: ["اتجاه الاستهلاك", "التحصيل والمتأخرات", "الربحية والفاقد", "تصدير قابل للطباعة"],
  },
  notifications: {
    icon: BellRing,
    eyebrow: "تواصل موثّق",
    title: "الإشعارات وروابط الفواتير",
    description: "متابعة رسائل WhatsApp وSMS وروابط الفواتير وحالات التسليم وإعادة المحاولة.",
    action: "عرض الطابور",
    checklist: ["قوالب فاتورة وتذكير", "حالة الإرسال والتسليم", "إعادة المحاولة الآمنة", "روابط فواتير عامة"],
  },
  audit: {
    icon: ShieldCheck,
    eyebrow: "الرقابة والامتثال",
    title: "سجل التدقيق والصلاحيات",
    description: "تتبع كل تعديل مالي وتشغيلي، مع أدوار مستقلة للمالك والمدير والمحاسب والمحصل والفني.",
    action: "مراجعة السجل",
    checklist: ["أدوار وصلاحيات منفصلة", "سجل عملية غير قابل للحذف", "مراجعة التعارضات", "حماية الوصول والأجهزة"],
  },
  map: {
    icon: MapPinned,
    eyebrow: "التغطية الميدانية",
    title: "خريطة الشبكة",
    description: "تمثيل المحطات والمناطق والمشتركين والعدادات على خريطة تشغيلية واضحة.",
    action: "استكشاف الخريطة",
    checklist: ["المحطات والمولدات", "مناطق التوزيع", "نقاط التوصيل والعدادات", "الأعطال والمهام الميدانية"],
  },
  settings: {
    icon: Settings2,
    eyebrow: "إعداد المنصة",
    title: "إعدادات PowerHub",
    description: "تخصيص بيانات المشروع والعملات والتعرفات وقواعد الفوترة وصلاحيات الفريق.",
    action: "فتح الإعدادات",
    checklist: ["بيانات الشركة والمحطات", "العملات والضرائب", "سياسة الاستحقاق", "إدارة أعضاء الفريق"],
  },
} as const;

export default function FeaturePage({ section }: { section: keyof typeof sections }) {
  const [, setLocation] = useLocation();
  const data = sections[section];
  const Icon = data.icon;

  return (
    <div className="space-y-8 pb-12">
      <section className="ph-hero-grid relative overflow-hidden rounded-[28px] border border-white/8 bg-[#111823] px-5 py-7 shadow-panel sm:px-8 sm:py-10">
        <div className="relative z-10 max-w-2xl">
          <button onClick={() => setLocation("/")} className="mb-7 flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-[#F5B800]">
            <ChevronLeft className="h-4 w-4" /> العودة إلى لوحة التحكم
          </button>
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#F5B800]/25 bg-[#F5B800]/10 px-3 py-1 text-xs font-bold text-[#F5B800]">
            <Icon className="h-3.5 w-3.5" /> {data.eyebrow}
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">{data.title}</h1>
          <p className="mt-3 max-w-xl leading-7 text-slate-300">{data.description}</p>
          <Button className="mt-7 bg-[#F5B800] px-5 font-bold text-[#0D1117] hover:bg-[#ffd23f]" onClick={() => window.alert("سيتم تفعيل هذه العملية بعد تجهيز بيانات المشروع.")}>{data.action}</Button>
        </div>
        <div className="absolute -left-16 -top-16 h-52 w-52 rounded-full bg-[#F5B800]/10 blur-3xl" />
        <div className="absolute bottom-0 left-0 h-px w-full bg-gradient-to-r from-transparent via-[#F5B800]/70 to-transparent" />
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.checklist.map((item, index) => (
          <Card key={item} className="border-white/8 bg-[#111823] shadow-none">
            <CardContent className="p-5">
              <div className="mb-5 grid h-8 w-8 place-items-center rounded-lg bg-[#F5B800]/10 text-sm font-bold text-[#F5B800]">0{index + 1}</div>
              <p className="font-bold text-white">{item}</p>
              <p className="mt-2 text-sm leading-6 text-slate-400">تُدار من خلال قاعدة بيانات موحدة وصلاحيات مخصصة لجهة العمل.</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.4fr_0.6fr]">
        <Card className="border-white/8 bg-[#111823] shadow-none">
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b border-white/8 px-6 py-5">
              <div>
                <h2 className="font-bold text-white">سجل الوحدة</h2>
                <p className="mt-1 text-sm text-slate-400">ستظهر العمليات المسجلة هنا فور إضافة بيانات المشروع.</p>
              </div>
              <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-slate-400">0 سجل</span>
            </div>
            <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-[#F5B800]/10 text-[#F5B800]"><Icon className="h-6 w-6" /></div>
              <h3 className="mt-4 font-bold text-white">ابدأ بإضافة أول سجل</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-400">كل البيانات التشغيلية والمالية في PowerHub مرتبطة بمحطة ومستخدم وسجل تدقيق واضح.</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#F5B800]/20 bg-gradient-to-b from-[#1b222c] to-[#111823] shadow-none">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 text-[#F5B800]"><Zap className="h-4 w-4 fill-current" /><span className="text-xs font-bold">PowerHub Control</span></div>
            <h3 className="mt-5 text-xl font-extrabold text-white">كل كيلوواط تحت السيطرة.</h3>
            <p className="mt-3 text-sm leading-7 text-slate-400">تابع البيانات التشغيلية والمالية من نفس المنصة، مع فصل دقيق للصلاحيات والمسؤوليات.</p>
            <div className="mt-7 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full w-[38%] rounded-full bg-[#F5B800]" /></div>
            <p className="mt-2 text-xs text-slate-500">المرحلة الحالية: إعداد بيانات التشغيل الأساسية</p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
