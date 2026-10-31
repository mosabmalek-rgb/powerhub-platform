import { useRef, type FormEvent } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { MailPlus, RefreshCw } from "lucide-react";

type TenantOption = { tenant: { id: number; name: string } };
type InvitationRow = {
  id: number;
  email: string;
  role: string;
  tenantId: number;
  tenantName: string;
  siteName?: string | null;
  invitationExpiresAt?: string | Date | null;
  invitationCreatedAt?: string | Date | null;
  invitationStatus?: string | null;
};

type InvitationPayload = {
  tenantId: number;
  email: string;
  tenantRole: "owner" | "admin" | "member";
  expiresInHours: 72;
};

type PendingOperation = {
  payloadKey: string;
  clientOperationId: string;
};

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const tenantRoleLabels: Record<string, string> = {
  owner: "مالك المساحة",
  admin: "مشرف المساحة",
  member: "عضو",
};

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("ar-PS", { dateStyle: "medium", timeStyle: "short" });
}

function invitationStatus(row: InvitationRow) {
  if (row.invitationExpiresAt && new Date(row.invitationExpiresAt).getTime() <= Date.now()) return "منتهية";
  return "بانتظار تسجيل الدخول";
}

export default function TenantAccessInvitationPanel({
  tenants,
  tenantsLoading = false,
  tenantsError = false,
  invitations = [],
}: {
  tenants: TenantOption[];
  tenantsLoading?: boolean;
  tenantsError?: boolean;
  invitations?: InvitationRow[];
}) {
  const utils = trpc.useUtils();
  const pendingOperation = useRef<PendingOperation | null>(null);
  const invite = trpc.admin.inviteTenantAccess.useMutation({
    onSuccess: async () => {
      await utils.admin.platformSnapshot.invalidate();
      toast.success("تم تسجيل دعوة الوصول. سيُفعّل الوصول عند تسجيل الدخول بالبريد نفسه.");
    },
    onError: (error) => toast.error(error.message),
  });

  function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload: InvitationPayload = {
      tenantId: Number(formData.get("tenantId")),
      email: String(formData.get("email")).trim().toLowerCase(),
      tenantRole: String(formData.get("tenantRole")) as InvitationPayload["tenantRole"],
      expiresInHours: 72,
    };
    const payloadKey = JSON.stringify(payload);
    if (!pendingOperation.current || pendingOperation.current.payloadKey !== payloadKey) {
      pendingOperation.current = {
        payloadKey,
        clientOperationId: globalThis.crypto.randomUUID(),
      };
    }
    const clientOperationId = pendingOperation.current.clientOperationId;

    invite.mutate({ ...payload, clientOperationId }, {
      onSuccess: () => {
        const currentFormData = new FormData(form);
        const currentPayload: InvitationPayload = {
          tenantId: Number(currentFormData.get("tenantId")),
          email: String(currentFormData.get("email")).trim().toLowerCase(),
          tenantRole: String(currentFormData.get("tenantRole")) as InvitationPayload["tenantRole"],
          expiresInHours: 72,
        };
        if (
          pendingOperation.current?.clientOperationId === clientOperationId &&
          JSON.stringify(currentPayload) === payloadKey
        ) {
          pendingOperation.current = null;
          form.reset();
        }
      },
    });
  }

  return (
    <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel">
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#F5B800]/10 text-[#F5B800]">
            <MailPlus className="h-5 w-5" />
          </span>
          <div>
            <h2 className="font-bold text-white">دعوة مستخدم إلى مساحة صاحب المولد</h2>
            <p className="mt-1 text-sm leading-7 text-slate-400">
              سجّل بريد المستخدم والدور المطلوب داخل مساحة محددة. تُفعّل العضوية عند تسجيل المستخدم الدخول بالبريد الإلكتروني نفسه.
            </p>
          </div>
        </div>

        <form
          className="mt-5 grid gap-3 rounded-2xl border border-white/8 bg-white/[.018] p-4 md:grid-cols-[1fr_1.2fr_.9fr_auto]"
          onSubmit={submitInvite}
        >
          <label className="block">
            <span className="mb-2 block text-xs font-bold text-slate-400">مساحة صاحب المولد</span>
            <select name="tenantId" required defaultValue="" disabled={tenantsLoading || tenantsError || tenants.length === 0} className={inputClass}>
              <option value="" disabled>اختر المساحة</option>
              {tenants.map((item) => (
                <option key={item.tenant.id} value={item.tenant.id}>{item.tenant.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-bold text-slate-400">البريد الإلكتروني</span>
            <Input name="email" required type="email" dir="ltr" placeholder="member@example.com" className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-bold text-slate-400">الدور داخل المساحة</span>
            <select name="tenantRole" defaultValue="member" className={inputClass}>
              <option value="member">عضو</option>
              <option value="admin">مشرف المساحة</option>
              <option value="owner">مالك المساحة</option>
            </select>
          </label>
          <div className="flex items-end">
            <Button type="submit" disabled={invite.isPending || tenantsLoading || tenantsError || tenants.length === 0} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">
              {invite.isPending ? <RefreshCw className="ml-2 h-4 w-4 animate-spin" /> : <MailPlus className="ml-2 h-4 w-4" />}
              تسجيل الدعوة
            </Button>
          </div>
        </form>

        {tenantsError ? (
          <p role="alert" className="mt-3 text-sm text-rose-300">تعذر تحميل مساحات أصحاب المولدات؛ لم يتم تمكين إنشاء الدعوة.</p>
        ) : null}
        {!tenantsError && !tenantsLoading && tenants.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">لا توجد مساحات متاحة لدعوة مستخدم إليها.</p>
        ) : null}

        <div className="mt-5 rounded-xl border border-amber-400/15 bg-amber-400/[.035] p-3 text-xs leading-6 text-amber-100/80">
          لا يرسل هذا الإجراء رسالة بريد إلكتروني تلقائيًا. شارك البريد والتعليمات مع المستخدم عبر قناتك المعتمدة؛ سيُفعّل النظام الدعوة عندما يسجّل الدخول بالبريد نفسه. صلاحية الدعوة 72 ساعة.
        </div>

        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-white">دعوات الوصول المعلّقة</h3>
            <Badge className="bg-white/5 text-slate-300">{invitations.length} دعوة</Badge>
          </div>
          <div className="mt-3 space-y-2">
            {invitations.map((row) => {
              const status = invitationStatus(row);
              const scope = row.siteName && row.siteName !== "—" ? " · " + row.siteName : "";
              return (
                <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/[.02] p-3">
                  <div>
                    <p className="text-sm font-bold text-white" dir="ltr">{row.email}</p>
                    <p className="mt-1 text-xs text-slate-500">{row.tenantName}{scope} · {tenantRoleLabels[row.role] ?? row.role}</p>
                    <p className="mt-1 text-xs text-slate-500">تاريخ الانتهاء: {formatDate(row.invitationExpiresAt)}</p>
                  </div>
                  <Badge className={status === "منتهية" ? "bg-rose-400/10 text-rose-300" : "bg-amber-400/10 text-amber-200"}>{status}</Badge>
                </div>
              );
            })}
            {invitations.length === 0 ? (
              <p className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">لا توجد دعوات وصول مسجلة حاليًا.</p>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
