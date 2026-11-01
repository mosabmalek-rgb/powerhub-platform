import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ShieldPlus, UserRoundCog } from "lucide-react";
import { FormEvent, useRef } from "react";
import { toast } from "sonner";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const roleLabels = { platform_owner: "مالك المنصة", platform_admin: "مشرف المنصة", finance_admin: "مشرف مالي", platform_support: "موظف دعم" } as const;
const statusLabels = { active: "فعّال", locked: "مقفل", disabled: "معطل", invited: "بانتظار الدخول", accepted: "مقبولة", revoked: "ملغاة", expired: "منتهية" } as const;

function roleLabel(value: unknown) {
  return typeof value === "string" && value in roleLabels ? roleLabels[value as keyof typeof roleLabels] : "حساب منصة";
}
function statusLabel(value: unknown) {
  return typeof value === "string" && value in statusLabels ? statusLabels[value as keyof typeof statusLabels] : "غير معروف";
}
function dateLabel(value: Date | string | null | undefined) {
  return value ? new Date(value).toLocaleDateString("ar-PS", { year: "numeric", month: "short", day: "numeric" }) : "—";
}

type PendingInvite = { payloadKey: string; clientOperationId: string };

export default function PlatformAccessPanel() {
  const utils = trpc.useUtils();
  const pendingInvite = useRef<PendingInvite | null>(null);
  const directory = trpc.admin.platformAccessDirectory.useQuery();
  const invite = trpc.admin.invitePlatformAccess.useMutation({
    onSuccess: async () => { await utils.admin.platformAccessDirectory.invalidate(); toast.success("تم تسجيل دعوة حساب المنصة."); },
    onError: (error) => toast.error(error.message),
  });
  const setStatus = trpc.admin.setPlatformAccountStatus.useMutation({
    onSuccess: async () => { await utils.admin.platformAccessDirectory.invalidate(); toast.success("تم تحديث حالة الحساب."); },
    onError: (error) => toast.error(error.message),
  });
  const setRole = trpc.admin.setPlatformAccessRole.useMutation({
    onSuccess: async () => { await utils.admin.platformAccessDirectory.invalidate(); toast.success("تم تحديث دور الحساب."); },
    onError: (error) => toast.error(error.message),
  });

  function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload = {
      email: String(formData.get("email")).trim().toLowerCase(),
      platformRole: String(formData.get("platformRole")) as "platform_admin" | "finance_admin" | "platform_support",
      expiresInHours: 72,
    };
    const payloadKey = JSON.stringify(payload);
    if (!pendingInvite.current || pendingInvite.current.payloadKey !== payloadKey) {
      pendingInvite.current = { payloadKey, clientOperationId: globalThis.crypto.randomUUID() };
    }
    const clientOperationId = pendingInvite.current.clientOperationId;

    invite.mutate({ ...payload, clientOperationId }, {
      onSuccess: () => {
        const currentFormData = new FormData(form);
        const currentPayload = {
          email: String(currentFormData.get("email")).trim().toLowerCase(),
          platformRole: String(currentFormData.get("platformRole")) as "platform_admin" | "finance_admin" | "platform_support",
          expiresInHours: 72,
        };
        if (
          pendingInvite.current?.clientOperationId === clientOperationId &&
          JSON.stringify(currentPayload) === payloadKey
        ) {
          pendingInvite.current = null;
          form.reset();
        }
      },
    });
  }

  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5">
    <div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#F5B800]/10 text-[#F5B800]"><UserRoundCog className="h-5 w-5" /></span><div><h2 className="font-bold text-white">وصول إدارة المنصة</h2><p className="mt-1 max-w-3xl text-sm leading-7 text-slate-500">مالك المنصة فقط ينشئ حسابات الإدارة. حساب «موظف دعم» مستقل ولا يحصل إلا على صلاحية مركز الدعم والمحادثات.</p></div></div>
    <form className="mt-5 grid gap-3 rounded-2xl border border-white/8 bg-white/[.018] p-4 md:grid-cols-[1.3fr_.9fr_auto]" onSubmit={submitInvite}>
      <Input name="email" required type="email" dir="ltr" placeholder="support@example.com" className={inputClass} />
      <select name="platformRole" defaultValue="platform_support" className={inputClass}><option value="platform_support">موظف دعم — الدعم فقط</option><option value="platform_admin">مشرف المنصة</option><option value="finance_admin">مشرف مالي</option></select>
      <Button type="submit" disabled={invite.isPending} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><ShieldPlus className="ml-2 h-4 w-4" />دعوة حساب</Button>
    </form>
    <div className="mt-6 grid gap-5 xl:grid-cols-2">
      <section><h3 className="text-sm font-bold text-white">حسابات الإدارة</h3><div className="mt-3 space-y-2">
        {directory.data?.accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/[.02] p-3">
          <div><p className="font-bold text-white">{account.name ?? account.email ?? `حساب #${account.id}`}</p><p className="mt-1 text-xs text-slate-500" dir="ltr">{account.email ?? "لا يوجد بريد"}</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={account.platformRole === "platform_support" ? "bg-sky-400/10 text-sky-300" : "bg-[#F5B800]/10 text-[#F5B800]"}>{roleLabel(account.platformRole)}</Badge>
            {account.platformRole !== "platform_owner" && <>
              <select aria-label={`دور حساب ${account.id}`} value={account.platformRole ?? "platform_admin"} onChange={(event) => setRole.mutate({ userId: account.id, platformRole: event.target.value as "platform_admin" | "finance_admin" | "platform_support" })} disabled={setRole.isPending} className="rounded-lg border border-white/10 bg-[#0D1117] px-2 py-1 text-xs text-white">
                <option value="platform_support">موظف دعم</option><option value="platform_admin">مشرف منصة</option><option value="finance_admin">مشرف مالي</option>
              </select>
              <select aria-label={`حالة حساب ${account.id}`} value={account.accountStatus} onChange={(event) => setStatus.mutate({ userId: account.id, status: event.target.value as "active" | "locked" | "disabled" })} disabled={setStatus.isPending} className="rounded-lg border border-white/10 bg-[#0D1117] px-2 py-1 text-xs text-white">
                <option value="active">فعّال</option><option value="locked">مقفل</option><option value="disabled">معطل</option>
              </select>
            </>}
          </div>
        </div>)}
        {!directory.data?.accounts.length && <p className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">لا توجد حسابات إدارة ظاهرة.</p>}
      </div></section>
      <section><h3 className="text-sm font-bold text-white">الدعوات المعلقة وسجلها</h3><div className="mt-3 space-y-2">
        {directory.data?.invitations.map((invitation) => <div key={invitation.id} className="rounded-xl border border-white/8 bg-white/[.02] p-3"><div className="flex items-center justify-between gap-3"><p className="text-sm font-bold text-white" dir="ltr">{invitation.email}</p><Badge className="bg-white/5 text-slate-300">{statusLabel(invitation.status)}</Badge></div><p className="mt-2 text-xs text-slate-500">{roleLabel(invitation.platformRole)} · ينتهي في {dateLabel(invitation.expiresAt)}</p></div>)}
        {!directory.data?.invitations.length && <p className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">لا توجد دعوات مسجلة.</p>}
      </div></section>
    </div>
  </CardContent></Card>;
}
