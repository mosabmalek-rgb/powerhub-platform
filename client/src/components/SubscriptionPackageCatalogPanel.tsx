import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { PackageCheck } from "lucide-react";
import { FormEvent } from "react";
import { toast } from "sonner";

const codes = ["basic","advanced","professional","business","vip"] as const;
const defaults = [
  { code:"basic", name:"الناشئة", price:123, smsCost:51, serviceNet:72, includedMessages:600, includedSubscribers:150, fieldUsers:1, platformUsers:2, branches:1, logoPolicy:"not_included", logoAddonPrice:0, subscriberLimitMode:"maximum", supportLevel:"standard" },
  { code:"advanced", name:"النمو", price:234, smsCost:102, serviceNet:132, includedMessages:1200, includedSubscribers:300, fieldUsers:2, platformUsers:2, branches:1, logoPolicy:"addon", logoAddonPrice:20, subscriberLimitMode:"maximum", supportLevel:"standard" },
  { code:"professional", name:"الاحتراف", price:345, smsCost:170, serviceNet:175, includedMessages:2000, includedSubscribers:500, fieldUsers:3, platformUsers:3, branches:1, logoPolicy:"addon", logoAddonPrice:20, subscriberLimitMode:"maximum", supportLevel:"priority" },
  { code:"business", name:"الأعمال", price:456, smsCost:255, serviceNet:201, includedMessages:3000, includedSubscribers:750, fieldUsers:4, platformUsers:3, branches:1, logoPolicy:"included", logoAddonPrice:0, subscriberLimitMode:"maximum", supportLevel:"priority_plus" },
  { code:"vip", name:"الذهبية / VIP", price:567, smsCost:340, serviceNet:227, includedMessages:4000, includedSubscribers:900, fieldUsers:4, platformUsers:4, branches:2, logoPolicy:"included", logoAddonPrice:0, subscriberLimitMode:"minimum", supportLevel:"highest_plus" },
] as const;

function asNumber(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function SubscriptionPackageCatalogPanel() {
  const utils = trpc.useUtils();
  const configuration = trpc.admin.platformConfiguration.useQuery();
  const save = trpc.admin.savePlatformSetting.useMutation({
    onSuccess: async () => {
      await utils.admin.platformConfiguration.invalidate();
      toast.success("تم حفظ عقد الباقات وحدود الميزات بنجاح.");
    },
    onError: (error) => toast.error(error.message),
  });

  const stored = configuration.data?.settings.find((s: any) => s.settingKey === "subscription_package_catalog");
  const value = stored?.value && typeof stored.value === "object" && !Array.isArray(stored.value) ? stored.value as Record<string, any> : {};
  const packages = Array.isArray(value.packages) ? value.packages as Array<Record<string, any>> : [];
  const getPackage = (code: string, fallback: any) => packages.find((item) => item.code === code) ?? fallback;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextPackages = defaults.map((fallback) => {
      const current = getPackage(fallback.code, fallback);
      const number = (key: string, min = 0) => Math.max(min, Math.trunc(asNumber(form.get(`${fallback.code}-${key}`), Number(current[key] ?? fallback[key] ?? 0))));
      const subscribers = number("includedSubscribers");
      const item = {
        ...current,
        code: fallback.code,
        name: String(form.get(`${fallback.code}-name`) || current.name || fallback.name).trim(),
        price: number("price"),
        smsCost: number("smsCost"),
        serviceNet: number("serviceNet"),
        includedMessages: number("includedMessages"),
        includedSubscribers: subscribers,
        fieldUsers: number("fieldUsers"),
        platformUsers: number("platformUsers"),
        branches: Math.max(1, number("branches", 1)),
        logoPolicy: String(form.get(`${fallback.code}-logoPolicy`) || current.logoPolicy || fallback.logoPolicy),
        logoAddonPrice: number("logoAddonPrice"),
        subscriberLimitMode: String(form.get(`${fallback.code}-subscriberLimitMode`) || current.subscriberLimitMode || fallback.subscriberLimitMode),
        supportLevel: String(form.get(`${fallback.code}-supportLevel`) || current.supportLevel || fallback.supportLevel),
        active: form.get(`${fallback.code}-active`) === "on",
        features: {
          subscribers: { limit: subscribers, mode: String(form.get(`${fallback.code}-subscriberLimitMode`) || current.subscriberLimitMode || fallback.subscriberLimitMode) },
          sms: { limit: number("includedMessages") },
          fieldUsers: { limit: number("fieldUsers") },
          platformUsers: { limit: number("platformUsers") },
          branches: { limit: Math.max(1, number("branches", 1)) },
          logo: {
            enabled: String(form.get(`${fallback.code}-logoPolicy`) || current.logoPolicy || fallback.logoPolicy) !== "not_included",
            included: String(form.get(`${fallback.code}-logoPolicy`) || current.logoPolicy || fallback.logoPolicy) === "included",
            addonPrice: number("logoAddonPrice"),
          },
          support: { level: String(form.get(`${fallback.code}-supportLevel`) || current.supportLevel || fallback.supportLevel) },
        },
      };
      return item;
    });
    save.mutate({
      settingKey: "subscription_package_catalog",
      isEnabled: true,
      message: "العقد المركزي للباقات: الأعداد والحدود والأسعار والميزات قابلة للتحكم من إدارة المنصة.",
      value: { currency: String(value.currency ?? "ILS"), version: Math.max(4, Number(value.version ?? 3) + 1), packages: nextPackages, addons: value.addons ?? {}, smsAddons: value.smsAddons ?? [] },
    });
  };

  return <section className="space-y-6">
    <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel">
      <CardContent className="p-5">
        <div className="flex items-start gap-3"><PackageCheck className="mt-1 h-5 w-5 text-[#F5B800]" /><div><h2 className="font-bold text-white">عقد ميزات الباقات وأعدادها</h2><p className="mt-1 max-w-4xl text-sm leading-7 text-slate-400">هذه الشاشة هي مصدر التحكم الإداري المركزي. تغيير العدد هنا ينعكس على عقد الباقة المستخدم في التشغيل، مع بقاء التحقق النهائي في الخادم وSupabase.</p></div></div>
      </CardContent>
    </Card>
    <form onSubmit={submit} className="grid gap-4 xl:grid-cols-2">
      {defaults.map((fallback) => {
        const current = getPackage(fallback.code, fallback);
        const n = (key: string) => Number(current[key] ?? fallback[key] ?? 0);
        return <Card key={fallback.code} className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5">
          <div className="flex items-center justify-between gap-3"><div><p className="text-xs text-slate-500" dir="ltr">{fallback.code}</p><Input name={`${fallback.code}-name`} defaultValue={String(current.name ?? fallback.name)} className="mt-1 h-9 font-bold" /></div><label className="flex items-center gap-2 text-xs text-slate-400"><input name={`${fallback.code}-active`} type="checkbox" defaultChecked={current.active !== false} className="accent-[#F5B800]" />فعّالة</label></div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {[
              ["price","السعر الشهري"],["smsCost","تكلفة SMS"],["serviceNet","صافي الخدمة"],["includedMessages","رسائل SMS"],["includedSubscribers","المشتركون"],["fieldUsers","مستخدمو التطبيق الميداني"],["platformUsers","حسابات المنصة"],["branches","الفروع"],["logoAddonPrice","سعر إضافة الشعار"],
            ].map(([key,label]) => <label key={key} className="text-xs text-slate-500">{label}<Input name={`${fallback.code}-${key}`} type="number" min={key==="branches" ? 1 : 0} step="1" defaultValue={n(key)} className="mt-1 h-9 text-xs" dir="ltr" /></label>)}
            <label className="text-xs text-slate-500">حد المشتركين
              <select name={`${fallback.code}-subscriberLimitMode`} defaultValue={String(current.subscriberLimitMode ?? fallback.subscriberLimitMode)} className="mt-1 h-9 w-full rounded-xl border border-white/10 bg-[#0D1117] px-2 text-xs text-white"><option value="maximum">حد أقصى</option><option value="minimum">حد أدنى / يبدأ من</option></select>
            </label>
            <label className="text-xs text-slate-500">الشعار
              <select name={`${fallback.code}-logoPolicy`} defaultValue={String(current.logoPolicy ?? fallback.logoPolicy)} className="mt-1 h-9 w-full rounded-xl border border-white/10 bg-[#0D1117] px-2 text-xs text-white"><option value="not_included">غير مشمول</option><option value="addon">إضافة مدفوعة</option><option value="included">مشمول</option></select>
            </label>
            <label className="text-xs text-slate-500 col-span-2">الدعم
              <select name={`${fallback.code}-supportLevel`} defaultValue={String(current.supportLevel ?? fallback.supportLevel)} className="mt-1 h-9 w-full rounded-xl border border-white/10 bg-[#0D1117] px-2 text-xs text-white"><option value="standard">قياسي</option><option value="priority">أولوية</option><option value="priority_plus">أولوية + مزايا إضافية</option><option value="highest_plus">أعلى أولوية + مزايا إضافية</option></select>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2"><Badge className="bg-white/5 text-slate-300">مشتركون: {n("includedSubscribers")}</Badge><Badge className="bg-white/5 text-slate-300">SMS: {n("includedMessages").toLocaleString("ar")}</Badge><Badge className="bg-white/5 text-slate-300">ميداني: {n("fieldUsers")}</Badge><Badge className="bg-white/5 text-slate-300">منصة: {n("platformUsers")}</Badge><Badge className="bg-white/5 text-slate-300">فروع: {n("branches")}</Badge></div>
        </CardContent></Card>;
      })}
      <div className="xl:col-span-2"><Button type="submit" disabled={save.isPending || configuration.isLoading} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{save.isPending ? "جارٍ حفظ العقد…" : "حفظ عقد ميزات وأعداد الباقات"}</Button></div>
    </form>
  </section>;
}
