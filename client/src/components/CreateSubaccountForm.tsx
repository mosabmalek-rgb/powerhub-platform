import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Loader2, UserRoundPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  powerCapabilityLabels, powerRoleLabels, type PowerCapability, type PowerRole,
} from "@shared/powerhub-rbac";
import { defaultStaffPermissionSelection } from "@shared/staff-permission-selection";

type StaffRole = Exclude<PowerRole, "owner">;
type SiteChoice = { id: number; name: string; tenantId: number };
export type CreateSubaccountPayload = {
  siteId: number; name: string; email: string; temporaryPassword: string;
  role: StaffRole; allBranches: boolean; permissions: PowerCapability[];
};

const fieldClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";

export default function CreateSubaccountForm({
  initialSiteId, sites, roles, ownerCapabilities, availableCapabilities,
  canUseAllBranches, isCatalogLoading, isCatalogError, isSaving, onCreate,
}: {
  initialSiteId: number;
  sites: SiteChoice[];
  roles: StaffRole[];
  ownerCapabilities: readonly PowerCapability[];
  availableCapabilities: readonly PowerCapability[];
  canUseAllBranches: boolean;
  isCatalogLoading: boolean;
  isCatalogError: boolean;
  isSaving: boolean;
  onCreate: (payload: CreateSubaccountPayload) => void;
}) {
  const [siteId, setSiteId] = useState(initialSiteId);
  const [role, setRole] = useState<StaffRole>(roles[0] ?? "viewer");
  const [allBranches, setAllBranches] = useState(false);
  const [permissions, setPermissions] = useState<PowerCapability[]>([]);
  const initialized = useRef(false);
  const accessible = useMemo(() => new Set(availableCapabilities), [availableCapabilities]);
  const selected = useMemo(() => new Set(permissions), [permissions]);
  const defaultPermissions = useMemo(() =>
    defaultStaffPermissionSelection(role, ownerCapabilities).filter((capability) => accessible.has(capability)),
  [role, ownerCapabilities, accessible]);

  useEffect(() => {
    if (isCatalogLoading || isCatalogError) return;
    // Initialize from the selected role once the verified owner-scoped catalog
    // arrives. A refetch must not silently restore a permission the user removed.
    if (!initialized.current) {
      initialized.current = true;
      setPermissions(defaultStaffPermissionSelection(role, availableCapabilities));
      return;
    }
    setPermissions((current) => current.filter((capability) => accessible.has(capability)));
  }, [accessible, availableCapabilities, isCatalogLoading, isCatalogError, role]);

  const allBranchesPossible = canUseAllBranches && sites.length > 1;
  const canSubmit = roles.includes(role) && sites.some((site) => site.id === siteId) &&
    !isCatalogLoading && !isCatalogError && !isSaving;

  const chooseRole = (next: StaffRole) => {
    setRole(next);
    setPermissions(defaultStaffPermissionSelection(next, availableCapabilities));
  };
  const restore = () => setPermissions(defaultPermissions);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const form = new FormData(event.currentTarget);
    onCreate({
      siteId, name: String(form.get("name") ?? "").trim(),
      email: String(form.get("email") ?? "").trim(),
      temporaryPassword: String(form.get("temporaryPassword") ?? ""),
      role, allBranches: allBranchesPossible && allBranches, permissions,
    });
  };

  return <form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={submit}>
    <label className="block text-xs font-bold text-slate-400">الاسم الكامل
      <input required name="name" minLength={2} className={fieldClass+" mt-2"} placeholder="الاسم الكامل للمستخدم" />
    </label>
    <label className="block text-xs font-bold text-slate-400">البريد الإلكتروني / اسم الدخول
      <input required type="email" name="email" className={fieldClass+" mt-2"} placeholder="accountant@example.com" />
    </label>
    <label className="block text-xs font-bold text-slate-400">كلمة المرور المؤقتة
      <input required minLength={8} type="password" autoComplete="new-password" name="temporaryPassword" className={fieldClass+" mt-2"} />
    </label>
    <label className="block text-xs font-bold text-slate-400">الدور
      <select required aria-label="الدور الافتراضي للحساب الفرعي" value={role}
        onChange={(event) => chooseRole(event.target.value as StaffRole)}
        className={fieldClass+" mt-2"}>
        {roles.map((item) => <option key={item} value={item} className="bg-[#111823]">{powerRoleLabels[item]}</option>)}
      </select>
    </label>
    <label className="block text-xs font-bold text-slate-400">الفرع
      <select required aria-label="الفرع المسموح للمستخدم" value={siteId}
        onChange={(event) => { setSiteId(Number(event.target.value)); setAllBranches(false); }}
        className={fieldClass+" mt-2"}>
        {sites.map((site) => <option key={site.id} value={site.id} className="bg-[#111823]">{site.name}</option>)}
      </select>
    </label>
    {allBranchesPossible && <label className="flex items-center gap-3 rounded-xl border border-[#F5B800]/20 bg-[#F5B800]/[.04] px-3 py-3 text-sm text-slate-200">
      <input type="checkbox" aria-label="صلاحية جميع الأفرع" checked={allBranches}
        onChange={(event) => setAllBranches(event.target.checked)} className="h-4 w-4 accent-[#F5B800]" />
      <span><strong className="block text-white">جميع الأفرع</strong>
        <span className="text-xs text-slate-400">يتطلب إتاحة تعدد الأفرع في الاشتراك</span></span>
    </label>}

    <section className="md:col-span-2 rounded-xl border border-white/10 bg-white/[.018] p-4" aria-label="تخصيص صلاحيات المستخدم الفرعي">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="font-bold text-white">الصلاحيات الافتراضية للدور</h3>
          <p className="mt-1 text-xs leading-6 text-slate-400">يمكنك إلغاء صلاحية مفعلة أو منح صلاحية إضافية ضمن الصلاحيات المتاحة لصاحب المولد. يُحفظ الاختيار مع إنشاء الحساب.</p></div>
        <Button type="button" variant="outline" size="sm" onClick={restore}
          disabled={isCatalogLoading || isCatalogError}
          className="border-white/15 text-slate-200">استعادة الافتراضي</Button>
      </div>
      {isCatalogLoading ? <p role="status" className="mt-3 text-sm text-slate-400">جارٍ تحميل الصلاحيات المتاحة…</p> :
        isCatalogError ? <p role="alert" className="mt-3 text-sm text-rose-300">تعذر التحقق من صلاحيات المالك. لن يتم إنشاء الحساب حتى اكتمال التحقق.</p> :
        <><p className="mt-3 text-xs text-[#F5B800]">المحدد: {permissions.length} من {availableCapabilities.length}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {availableCapabilities.map((capability) => <label key={capability} className="flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-[#0d1117] px-3 py-2 text-sm text-slate-200 hover:border-[#F5B800]/40">
              <input type="checkbox" checked={selected.has(capability)}
                onChange={(event) => setPermissions((current) => event.target.checked
                  ? [...new Set([...current, capability])]
                  : current.filter((item) => item !== capability))}
                className="h-4 w-4 accent-[#F5B800]" />
              {powerCapabilityLabels[capability]}
            </label>)}
          </div>
          {availableCapabilities.length === 0 && <p className="mt-3 text-sm text-amber-200">لا توجد صلاحيات قابلة للتفويض. يمكن إنشاء حساب دون أي صلاحيات تشغيلية.</p>}
        </>}
    </section>
    <Button disabled={!canSubmit}
      className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f] md:col-span-2">
      {isSaving ? <><Loader2 className="ml-2 h-4 w-4 animate-spin" />جارٍ إنشاء الحساب...</> :
        <><UserRoundPlus className="ml-2 h-4 w-4" />إنشاء الحساب الفرعي بالصلاحيات المختارة</>}
    </Button>
  </form>;
}
