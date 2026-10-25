import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Building2, KeyRound, Plus, UserRoundCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { trpc } from "@/lib/trpc";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";

type OwnerSubscriptionRegistrationProps = {
  rows: any[];
  pending: boolean;
  onCreate: (input: {
    clientOperationId: string;
    companyName: string;
    ownerName: string;
    identityNumber: string;
    ownerPhone: string;
    ownerWhatsapp: string;
    ownerEmail: string;
    temporaryPassword: string;
    packageCode: string;
    billingCycle: "monthly" | "yearly";
    subscriptionDuration: number;
    trialEnabled: boolean;
    trialDurationDays?: number;
  }) => Promise<unknown>;
  creationAvailable: boolean;
  onGoToFinance?: () => void;
};

export default function OwnerSubscriptionRegistration({ rows, pending, onCreate, creationAvailable, onGoToFinance }: OwnerSubscriptionRegistrationProps) {
  const [clientOperationId, setClientOperationId] = useState(() => crypto.randomUUID());
  const openProfile = (tenantId: number) => { window.history.pushState({}, "", `/admin/owner-subscriptions/${tenantId}`); window.dispatchEvent(new PopStateEvent("popstate")); };
  const catalog = trpc.powerhub.publicPackageCatalog.useQuery(undefined, { staleTime: 60_000 });
  const availablePackages = (catalog.data?.packages ?? []).filter((pkg: any) => pkg.active !== false);
  return <section className="space-y-6">
    <Card className="border-white/8 bg-[#111823] shadow-panel">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 text-[#F5B800]"><UserRoundCheck className="h-5 w-5" /><h2 className="font-bold text-white">ما يحدث بعد التسجيل</h2></div>
        <ol className="mt-5 space-y-4 text-sm leading-7 text-slate-300">
          <li className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#F5B800]/15 text-xs font-bold text-[#F5B800]">1</span><span>ينشئ النظام حساب الدخول بالبريد الإلكتروني وكلمة المرور المؤقتة.</span></li>
          <li className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#F5B800]/15 text-xs font-bold text-[#F5B800]">2</span><span>يُطلب من المالك تغيير كلمة المرور عند أول دخول.</span></li>
          <li className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#F5B800]/15 text-xs font-bold text-[#F5B800]">3</span><span>يضيف المالك أو المشرف بيانات أول مولد، مثل القدرة ونوع الوقود، من داخل الحساب.</span></li>
        </ol>
        <div className="mt-5 rounded-xl border border-sky-400/20 bg-sky-400/[.05] p-3 text-xs leading-6 text-sky-100"><KeyRound className="ml-1 inline h-3.5 w-3.5" />لا تُعرض كلمة المرور أو تُخزن في PowerHub بعد إنشاء حساب الدخول.</div>
      </CardContent>
    </Card>

    <Card className="border-white/8 bg-[#111823] shadow-panel">
      <CardContent className="p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-bold text-white">اشتراكات أصحاب المولدات</h2>
            <p className="mt-1 text-sm text-slate-500">إجمالي المساحات المسجلة: {rows.length}</p>
          </div>
          {onGoToFinance ? <Button type="button" variant="outline" onClick={onGoToFinance} className="border-[#F5B800]/40 text-[#F5B800] hover:bg-[#F5B800]/10 hover:text-[#ffd23f]">
            <ArrowLeft className="ml-2 h-4 w-4" />إدارة التجديدات في المالية
          </Button> : null}
        </div>
        <div className="mt-4 max-h-64 space-y-3 overflow-auto">{rows.map((row) => <button type="button" className="w-full rounded-xl border border-white/8 bg-white/[.02] p-3 text-right transition hover:border-[#F5B800]/40 hover:bg-[#F5B800]/[.04]" key={row.tenant.id} onClick={() => openProfile(Number(row.tenant.id))}><div className="flex items-center justify-between gap-3"><div><p className="font-bold text-white">{row.owner?.companyName ?? row.tenant.name}</p><p className="mt-1 text-xs text-slate-500">{row.owner?.fullName ?? "بانتظار ربط الحساب"} · {row.subscription?.packageCode ?? "—"}</p></div><span className="text-xs font-bold text-[#F5B800]">فتح الملف</span></div></button>)}{!rows.length && <p className="py-6 text-center text-sm text-slate-500">لا توجد اشتراكات مسجلة بعد.</p>}</div>
      </CardContent>
    </Card>

    <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel">
      <CardContent className="p-5">
        <div className="flex items-start gap-3"><div className="rounded-xl bg-[#F5B800]/10 p-2 text-[#F5B800]"><Building2 className="h-5 w-5" /></div><div><h2 className="font-bold text-white">تسجيل اشتراك صاحب مولد</h2><p className="mt-1 text-sm leading-6 text-slate-400">أدخل بيانات الشركة والمالك فقط. يستطيع المالك إضافة بيانات أول مولد بعد دخوله وتغيير كلمة المرور المؤقتة.</p></div></div>
        {!creationAvailable && <div className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/[.06] p-3 text-xs leading-6 text-amber-100">الإنشاء متوقف انتقالياً أثناء ترحيل دورة Supabase Auth والمعاملة الذرية. لا تُرسل البيانات ولا يُنشأ أي حساب أو اشتراك حتى اعتماد الدورة الآمنة.</div>}
        <form className="mt-6 space-y-4" onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (!creationAvailable) return;
          const data = new FormData(event.currentTarget);
          void onCreate({
            clientOperationId,
            companyName: String(data.get("companyName")).trim(),
            ownerName: String(data.get("ownerName")).trim(),
            identityNumber: String(data.get("identityNumber")).trim(),
            ownerPhone: String(data.get("ownerPhone")).trim(),
            ownerWhatsapp: String(data.get("ownerWhatsapp")).trim(),
            ownerEmail: String(data.get("ownerEmail")).trim(),
            temporaryPassword: String(data.get("temporaryPassword")),
            packageCode: String(data.get("packageCode")),
            billingCycle: String(data.get("billingCycle")) as "monthly" | "yearly",
            subscriptionDuration: Number(data.get("subscriptionDuration") || 1),
            trialEnabled: data.get("trialEnabled") === "on",
            trialDurationDays: data.get("trialEnabled") === "on" ? Number(data.get("trialDurationDays") || 8) : undefined
          }).then(() => setClientOperationId(crypto.randomUUID())).catch(() => undefined);
        }}>
          <fieldset disabled={!creationAvailable || pending} className="space-y-4 disabled:opacity-55">
            <Input required name="companyName" placeholder="اسم الشركة — مثال: مولدات الحي الشمالي" className={inputClass} />
            <Input required name="ownerName" placeholder="الاسم الكامل لمالك الشركة" className={inputClass} />
            <Input required name="identityNumber" placeholder="رقم الهوية" dir="ltr" className={inputClass} />
            <div className="grid gap-3 sm:grid-cols-2"><Input required name="ownerPhone" placeholder="رقم الجوال" dir="ltr" className={inputClass} /><Input name="ownerWhatsapp" placeholder="رقم WhatsApp (اختياري)" dir="ltr" className={inputClass} /></div>
            <Input required name="ownerEmail" type="email" placeholder="البريد الإلكتروني لتسجيل الدخول" dir="ltr" className={inputClass} />
            <Input required name="temporaryPassword" type="password" minLength={8} placeholder="كلمة المرور المؤقتة (8+ رموز)" dir="ltr" className={inputClass} />
            <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">نوع الاشتراك</span><select required name="packageCode" className={inputClass}>{availablePackages.map((pkg: any) => <option key={String(pkg.code)} value={String(pkg.code)}>{String(pkg.name)} · {Number(pkg.price).toLocaleString("ar-PS")} {catalog.data?.currency === "ILS" ? "₪" : catalog.data?.currency}</option>)}</select>{!availablePackages.length && <span className="mt-1 block text-xs text-rose-300">لا توجد باقات فعّالة متاحة حاليًا.</span>}</label>
            <div className="grid gap-3 sm:grid-cols-2"><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">دورة الاشتراك</span><select required name="billingCycle" defaultValue="monthly" className={inputClass}><option value="monthly">شهري</option><option value="yearly">سنوي</option></select></label><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">مدة الاشتراك</span><Input required name="subscriptionDuration" type="number" min={1} max={60} defaultValue={1} className={inputClass} dir="ltr" /><span className="mt-1 block text-xs text-slate-500">عدد الأشهر أو السنوات حسب الدورة.</span></label></div>
            <label className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.02] p-3 text-sm text-slate-300"><input name="trialEnabled" type="checkbox" className="accent-[#F5B800]" />تفعيل فترة تجريبية اختيارية</label>
            <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">مدة التجربة بالأيام</span><Input name="trialDurationDays" type="number" min={1} max={3650} defaultValue={8} className={inputClass} dir="ltr" /><span className="mt-1 block text-xs text-slate-500">تُستخدم فقط عند تفعيل التجربة، من 1 إلى 3650 يومًا.</span></label>
            <Button disabled={!creationAvailable || pending} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Plus className="ml-2 h-4 w-4" />إنشاء اشتراك صاحب مولد</Button>
          </fieldset>
        </form>
      </CardContent>
    </Card>
  </section>;
}
