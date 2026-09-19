import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ShieldPlus, UserRoundCog } from "lucide-react";
import { FormEvent } from "react";
import { toast } from "sonner";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const roleLabels = { platform_owner: "مالك المنصة", platform_admin: "مشرف المنصة", finance_admin: "مشرف مالي" } as const;
const statusLabels = { active: "فعّال", locked: "مقفل", disabled: "معطل", invited: "بانتظار تسجيل الدخول", accepted: "مقبولة", revoked: "ملغاة", expired: "منتهية" } as const;

function roleLabel(value: unknown) {
  return typeof value === "string" && value in roleLabels ? roleLabels[value as keyof typeof roleLabels] : "مشرف المنصة";
}

function statusLabel(value: unknown) {
  return typeof value === "string" && value in statusLabels ? statusLabels[value as keyof typeof statusLabels] : "غير معروف";
}

function dateLabel(value: Date | string | null | undefined) {
  return value ? new Date(value).toLocaleDateString("ar-IQ", { year: "numeric", month: "short", day: "numeric" }) : "—";
}

export default function PlatformAccessPanel() {
  const utils = trpc.useUtils();
  const directory = trpc.admin.platformAccessDirectory.useQuery();
  const invite = trpc.admin.invitePlatformAccess.useMutation({
    onSuccess: async (result) => {
      await utils.admin.platformAccessDirectory.invalidate();
      toast.success(result.replayed ? "تم تأكيد دعوة الوصول السابقة." : "تم تسجيل الدعوة. سيتفعل دور المنصة بعد أول دخول OAuth بالبريد نفسه.");
    },
    onError: (error) => toast.error(error.message),
  });
  const setStatus = trpc.admin.setPlatformAccountStatus.useMutation({
    onSuccess: async (result) => {
      await utils.admin.platformAccessDirectory.invalidate();
      toast.success(result.replayed ? "تم تأكيد حالة الحساب السابقة." : "تم تحديث حالة الحساب.");
    },
    onError: (error) => toast.error(error.message),
  });

  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#F5B800]/10 text-[#F5B800]"><UserRoundCog className="h-5 w-5" /></span><div><h2 className="font-bold text-white">وصول إدارة المنصة</h2><p className="mt-1 max-w-3xl text-sm leading-7 text-slate-500">هذه الوحدة مخصصة لمالك المنصة فقط. لا تُنشئ كلمات مرور ولا تعرض رموز دعوة؛ يُفعّل الوصول بعد أول تسجيل OAuth بالبريد المدعو.</p></div></div><form className="mt-5 grid gap-3 rounded-2xl border border-white/8 bg-white/[.018] p-4 md:grid-cols-[1.3fr_.8fr_auto]" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); invite.mutate({ email: String(form.get("email")), platformRole: String(form.get("platformRole")) as "platform_admin", expiresInHours: 72, clientOperationId: crypto.randomUUID() }); event.currentTarget.reset(); }}><Input name="email" required type="email" dir="ltr" placeholder="admin@example.com" className={inputClass} /><select name="platformRole" className={inputClass}><option value="platform_admin">مشرف المنصة</option><option value="finance_admin">مشرف مالي</option></select><Button disabled={invite.isPending} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><ShieldPlus className="ml-2 h-4 w-4" />دعوة مشرف</Button></form><div className="mt-6 grid gap-5 xl:grid-cols-2"><section><h3 className="text-sm font-bold text-white">حسابات الإدارة</h3><div className="mt-3 space-y-2">{directory.data?.accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/[.02] p-3"><div><p className="font-bold text-white">{account.name ?? account.email ?? `حساب #${account.id}`}</p><p className="mt-1 text-xs text-slate-500" dir="ltr">{account.email ?? "لا يوجد بريد"}</p></div><div className="flex items-center gap-2"><Badge className="bg-[#F5B800]/10 text-[#F5B800]">{roleLabel(account.platformRole ?? "platform_admin")}</Badge>{account.platformRole !== "platform_owner" && <select aria-label={`حالة حساب ${account.id}`} value={account.accountStatus} onChange={(event) => setStatus.mutate({ userId: account.id, accountStatus: event.target.value as "active" | "locked" | "disabled" })} disabled={setStatus.isPending} className="rounded-lg border border-white/10 bg-[#0D1117] px-2 py-1 text-xs text-white"><option value="active">فعّال</option><option value="locked">مقفل</option><option value="disabled">معطل</option></select>}</div></div>)}{!directory.data?.accounts.length && <p className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">لا توجد حسابات إدارة ظاهرة.</p>}</div></section><section><h3 className="text-sm font-bold text-white">الدعوات المعلقة وسجلها</h3><div className="mt-3 space-y-2">{directory.data?.invitations.map((invitation) => <div key={invitation.id} className="rounded-xl border border-white/8 bg-white/[.02] p-3"><div className="flex items-center justify-between gap-3"><p className="text-sm font-bold text-white" dir="ltr">{invitation.email}</p><Badge className="bg-white/5 text-slate-300">{statusLabel(invitation.status)}</Badge></div><p className="mt-2 text-xs text-slate-500">{roleLabel(invitation.platformRole)} · ينتهي في {dateLabel(invitation.expiresAt)}</p></div>)}{!directory.data?.invitations.length && <p className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">لا توجد دعوات مسجلة.</p>}</div></section></div></CardContent></Card>;
}
