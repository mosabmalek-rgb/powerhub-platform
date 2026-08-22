import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { powerCapabilityLabels, type PowerCapability } from "@shared/powerhub-rbac";

type StaffRow = { profile: { id: number; role: string; permissions: string[] | null; customRoleId: number | null }; user: { id: number; name: string | null; email: string | null } };
const capabilities = Object.keys(powerCapabilityLabels) as PowerCapability[];

export default function FlexiblePermissionsPanel({ siteId, staff, canManageTeam }: { siteId: number; staff: StaffRow[]; canManageTeam: boolean }) {
  const utils = trpc.useUtils();
  const [profileId, setProfileId] = useState<number | null>(null);
  const [permissions, setPermissions] = useState<PowerCapability[]>([]);
  const [customRoleId, setCustomRoleId] = useState<number | null>(null);
  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const customRoles = trpc.powerhub.staff.customRoles.useQuery({ siteId }, { enabled: Boolean(siteId && canManageTeam) });
  const update = trpc.powerhub.staff.updatePermissions.useMutation({ onSuccess: async () => { await utils.powerhub.staff.list.invalidate(); toast.success("تم حفظ الصلاحيات المخصصة للحساب."); }, onError: (error) => toast.error(error.message) });
  const saveRole = trpc.powerhub.staff.saveCustomRole.useMutation({ onSuccess: async () => { await utils.powerhub.staff.customRoles.invalidate(); setRoleName(""); setRoleDescription(""); toast.success("تم حفظ الدور المخصص وإتاحته لإعادة الاستخدام."); }, onError: (error) => toast.error(error.message) });
  const selected = useMemo(() => staff.find((row) => row.profile.id === profileId), [staff, profileId]);
  if (!canManageTeam) return null;
  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="space-y-5 p-5">
    <div><h2 className="font-bold text-white">مصفوفة الصلاحيات المرنة</h2><p className="mt-1 text-sm leading-6 text-slate-400">اختر مستخدماً وحدد صلاحياته مباشرة، أو احفظ المجموعة كدور مخصص لاستخدامها مع حسابات أخرى.</p></div>
    <div className="grid gap-3 md:grid-cols-[1fr_1fr]"><label className="text-xs text-slate-400">الحساب الفرعي<select aria-label="اختيار الحساب لتعديل الصلاحيات" value={profileId ?? ""} onChange={(event) => { const id = Number(event.target.value); const row = staff.find((item) => item.profile.id === id); setProfileId(id || null); setCustomRoleId(row?.profile.customRoleId ?? null); setPermissions((row?.profile.permissions ?? []) as PowerCapability[]); }} className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-[#0d1117] px-3 text-sm text-white"><option value="">اختر حساباً</option>{staff.filter((row) => row.profile.role !== "owner").map((row) => <option key={row.profile.id} value={row.profile.id}>{row.user.name || row.user.email || `حساب #${row.user.id}`}</option>)}</select></label><label className="text-xs text-slate-400">تطبيق دور محفوظ<select aria-label="تطبيق دور مخصص" value="" onChange={(event) => { const role = customRoles.data?.find((item) => String(item.id) === event.target.value); setCustomRoleId(role?.id ?? null); if (role) setPermissions(role.permissions as PowerCapability[]); }} className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-[#0d1117] px-3 text-sm text-white"><option value="">اختر دوراً مخصصاً</option>{customRoles.data?.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label></div>
    {selected && <><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{capabilities.map((capability) => <label key={capability} className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/[.025] px-3 py-2 text-sm text-slate-200 hover:border-[#F5B800]/50"><input type="checkbox" checked={permissions.includes(capability)} onChange={(event) => setPermissions((current) => event.target.checked ? Array.from(new Set([...current, capability])) : current.filter((item) => item !== capability))} className="h-4 w-4 accent-[#F5B800]" />{powerCapabilityLabels[capability]}</label>)}</div><Button type="button" disabled={!permissions.length || update.isPending} onClick={() => update.mutate({ siteId, profileId: selected.profile.id, customRoleId, permissions })} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{update.isPending ? "جارٍ الحفظ..." : "حفظ صلاحيات الحساب"}</Button></>}
    <div className="rounded-2xl border border-white/10 bg-white/[.018] p-4"><h3 className="font-bold text-white">حفظ المجموعة كدور مخصص</h3><div className="mt-3 grid gap-3 md:grid-cols-2"><Input value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="اسم الدور، مثال: محصل رئيسي" className="border-white/10 bg-[#0d1117] text-white" /><Textarea value={roleDescription} onChange={(event) => setRoleDescription(event.target.value)} placeholder="وصف اختياري" className="border-white/10 bg-[#0d1117] text-white" /></div><Button type="button" disabled={!roleName.trim() || !permissions.length || saveRole.isPending} onClick={() => saveRole.mutate({ siteId, name: roleName.trim(), description: roleDescription.trim() || undefined, permissions })} variant="outline" className="mt-3 border-[#F5B800]/40 text-[#F5B800] hover:bg-[#F5B800]/10">{saveRole.isPending ? "جارٍ الحفظ..." : "حفظ كدور قابل لإعادة الاستخدام"}</Button></div>
  </CardContent></Card>;
}
