import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { enqueueOfflineHrWork, listOfflineWork, type HrEmployeeCreateDraft, type HrEmployeeUpdateDraft, type QueuedOfflineWork } from "@/lib/offline-work-queue";
import { BriefcaseBusiness, PencilLine, Plus, Search, UserRound, X } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";

const jobLabels: Record<string, string> = { accountant: "محاسب", collector: "محصل", technician: "فني", worker: "عامل", supervisor: "مشرف فرع", other: "أخرى" };
const contractLabels: Record<string, string> = { daily: "يومي", monthly: "شهري", collection_percentage: "نسبة من التحصيل" };
const statusLabels: Record<string, string> = { active: "نشط", suspended: "موقوف", ended: "منتهي" };
const money = (value: unknown) => new Intl.NumberFormat("ar-PS", { maximumFractionDigits: 2 }).format(Number(value ?? 0));

export default function HumanResourcesPage({ embedded = false }: { embedded?: boolean }) {
  const sites = trpc.powerhub.sites.list.useQuery(undefined);
  const { branchId: siteId } = useBranchFilter(sites.data);
  const auth = useAuth();
  const { isOnline } = usePowerHubConnectivity();
  const userId = Number(auth.user?.id);
  const tenantId = Number((sites.data as any[] | undefined)?.find((site) => site.id === siteId)?.tenantId);
  const isHrOnline = isOnline && auth.isOnlineAuthenticated && auth.powerHubReachable;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"active" | "suspended" | "ended" | undefined>();
  const [jobTitle, setJobTitle] = useState<string | undefined>();
  const [pendingHrWork, setPendingHrWork] = useState<QueuedOfflineWork[]>([]);
  useEffect(() => {
    if (!Number.isSafeInteger(userId) || userId < 1 || !siteId) { setPendingHrWork([]); return; }
    let active = true;
    const reloadQueue = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: number; siteId?: number }>).detail;
      if (detail?.userId !== userId || detail?.siteId !== siteId) return;
      void listOfflineWork({ userId, siteId }).then((items) => { if (active) setPendingHrWork(items); }).catch(() => undefined);
    };
    window.addEventListener("powerhub:offline-work-queue-changed", reloadQueue);
    void listOfflineWork({ userId, siteId }).then((items) => { if (active) setPendingHrWork(items); })
      .catch(() => { if (active) setPendingHrWork([]); });
    return () => { active = false; window.removeEventListener("powerhub:offline-work-queue-changed", reloadQueue); };
  }, [userId, siteId]);
  const refreshPendingHrWork = async () => {
    const items = await listOfflineWork({ userId, siteId: siteId! });
    setPendingHrWork(items);
    return items;
  };
  const directory = trpc.powerhub.staff.directory.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId) && isHrOnline });
  const overview = trpc.powerhub.hr.overview.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId) && isHrOnline });
  const employees = trpc.powerhub.hr.listEmployees.useQuery({ siteId: siteId ?? 0, search: search || undefined, employmentStatus: status, jobTitle: jobTitle as any }, { enabled: Boolean(siteId) && isHrOnline });
  const offlineDirectory = trpc.powerhub.hr.offlineDirectory.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId), refetchOnMount: isHrOnline });
  const baseEmployees: any[] = isHrOnline && employees.data ? employees.data : (offlineDirectory.data ?? []);
  const employeesWithPendingWork = pendingHrWork.filter((item) => item.status !== "applied" &&
    (item.kind === "employee_create" || item.kind === "employee_update"));
  const mergedEmployees = employeesWithPendingWork.reduce((rows: any[], item) => {
    if (item.kind === "employee_create") {
      const payload = item.payload as HrEmployeeCreateDraft;
      const row = {
        id: payload.localEmployeeId, tenantId, siteId, fullName: payload.fullName,
        jobTitle: payload.jobTitle, employmentStatus: payload.employmentStatus,
        contractType: payload.contractType, createdAt: new Date(item.createdAt), versionNo: 1,
        pendingOffline: true, pendingQueueStatus: item.status,
      };
      return [row, ...rows.filter((employee) => Number(employee.id) !== payload.localEmployeeId)];
    }
    const payload = item.payload as HrEmployeeUpdateDraft;
    const prior = rows.find((employee) => Number(employee.id) === payload.employeeId);
    const fallback = {
      id: payload.employeeId, tenantId, siteId, fullName: payload.patch.fullName ?? ("موظف #" + payload.employeeId),
      jobTitle: payload.patch.jobTitle ?? "other", employmentStatus: payload.patch.employmentStatus ?? "active",
      contractType: payload.patch.contractType ?? "monthly", createdAt: new Date(item.createdAt),
    };
    const updated = { ...(prior ?? fallback), ...payload.patch, pendingOffline: true, pendingQueueStatus: item.status };
    return prior
      ? rows.map((employee) => Number(employee.id) === payload.employeeId ? updated : employee)
      : [updated, ...rows];
  }, baseEmployees.map((employee) => ({ ...employee })));
  const displayEmployees: any[] = mergedEmployees
    .filter((employee) => !search || String(employee.fullName ?? "").toLocaleLowerCase("ar").includes(search.toLocaleLowerCase("ar")))
    .filter((employee) => !status || employee.employmentStatus === status)
    .filter((employee) => !jobTitle || employee.jobTitle === jobTitle)
    .map((employee) => ({ ...employee, identityNo: isHrOnline ? employee.identityNo ?? null : null,
      phone: isHrOnline ? employee.phone ?? null : null, baseWage: isHrOnline ? employee.baseWage ?? null : null,
      hireDate: isHrOnline ? employee.hireDate ?? null : null, notes: isHrOnline ? employee.notes ?? null : null,
      linkedUserId: isHrOnline ? employee.linkedUserId ?? null : null }));
  const create = trpc.powerhub.hr.createEmployee.useMutation({ onSuccess: async () => { await Promise.all([employees.refetch(), overview.refetch()]); setShowEmployeeForm(false); toast.success("تمت إضافة الموظف بنجاح."); }, onError: (error) => toast.error(error.message) });
  const [editing, setEditing] = useState<any | null>(null);
  const [showEmployeeForm, setShowEmployeeForm] = useState(false);
  const update = trpc.powerhub.hr.updateEmployee.useMutation({ onSuccess: async () => { await Promise.all([employees.refetch(), overview.refetch()]); setEditing(null); toast.success("تم تحديث بيانات الموظف."); }, onError: (error) => toast.error(error.message) });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!siteId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      fullName: String(form.get("fullName") || "").trim(),
      identityNo: String(form.get("identityNo") || "").trim() || null,
      phone: String(form.get("phone") || "").trim() || null,
      jobTitle: String(form.get("jobTitle")) as HrEmployeeCreateDraft["jobTitle"],
      employmentStatus: "active" as const,
      contractType: String(form.get("contractType")) as HrEmployeeCreateDraft["contractType"],
      baseWage: Number(form.get("baseWage")),
      hireDate: String(form.get("hireDate") || "") || null,
      notes: String(form.get("notes") || "").trim() || null,
      linkedUserId: isHrOnline && form.get("linkedUserId") ? Number(form.get("linkedUserId")) : null,
    };
    if (!payload.fullName || !Number.isFinite(payload.baseWage) || payload.baseWage < 0) {
      toast.error("أدخل اسمًا وأجرًا أساسيًا صحيحين.");
      return;
    }
    if (!isHrOnline) {
      if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(tenantId) || tenantId < 1) {
        toast.error("لا تتوفر هوية المستخدم ونطاق الشركة المحفوظان؛ لم تُحفظ المسودة.");
        return;
      }
      try {
        const localEmployeeId = -Date.now();
        const queued = await enqueueOfflineHrWork({
          userId, tenantId, siteId, kind: "employee_create",
          payload: { localEmployeeId, ...payload },
        });
        await refreshPendingHrWork();
        setShowEmployeeForm(false);
        formElement.reset();
        toast.success("حُفظت مسودة الموظف على هذا الجهاز. لن تُنشأ في الخادم حتى تنجح المزامنة.");
        void queued;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "تعذر حفظ مسودة الموظف محليًا.");
      }
      return;
    }
    create.mutate({ siteId, ...payload, identityNo: payload.identityNo ?? undefined, phone: payload.phone ?? undefined, hireDate: payload.hireDate ?? undefined, notes: payload.notes ?? undefined, linkedUserId: payload.linkedUserId ?? undefined }, { onSuccess: () => formElement.reset() });
  };
  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!siteId || !editing) return;
    const form = new FormData(event.currentTarget);
    const safePatch = {
      fullName: String(form.get("fullName") || "").trim(),
      jobTitle: String(form.get("jobTitle")) as HrEmployeeCreateDraft["jobTitle"],
      contractType: String(form.get("contractType")) as HrEmployeeCreateDraft["contractType"],
      employmentStatus: String(form.get("employmentStatus")) as HrEmployeeCreateDraft["employmentStatus"],
    };
    if (!safePatch.fullName) return toast.error("اسم الموظف مطلوب.");
    if (!isHrOnline) {
      if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(tenantId) || tenantId < 1) {
        toast.error("لا تتوفر هوية المستخدم ونطاق الشركة المحفوظان؛ لم تُحفظ المسودة.");
        return;
      }
      try {
        const queuedItems = await listOfflineWork({ userId, siteId });
        const localCreate = editing.id < 0 ? queuedItems.find((item) => item.kind === "employee_create" &&
          item.status !== "applied" && (item.payload as HrEmployeeCreateDraft).localEmployeeId === editing.id) : undefined;
        const versionNo = Number(editing.versionNo);
        if (editing.id > 0 && (!Number.isSafeInteger(versionNo) || versionNo < 1)) {
          toast.error("لا توجد نسخة موثوقة للموظف؛ يلزم استعادة النسخة الحديثة قبل تعديلها دون اتصال.");
          return;
        }
        const work = await enqueueOfflineHrWork({
          userId, tenantId, siteId, kind: "employee_update",
          dependsOn: localCreate ? [localCreate.clientOperationId] : [],
          payload: {
            employeeId: Number(editing.id), expectedVersion: editing.id < 0 ? null : versionNo,
            patch: safePatch,
          },
        });
        await refreshPendingHrWork();
        setEditing(null);
        toast.success("حُفظ التعديل محليًا بانتظار المزامنة. الحقول الشخصية والمالية لا تتغير دون اتصال.");
        void work;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "تعذر حفظ تعديل الموظف محليًا.");
      }
      return;
    }
    update.mutate({
      siteId, employeeId: Number(editing.id), fullName: safePatch.fullName,
      identityNo: String(form.get("identityNo") || "").trim() || null,
      phone: String(form.get("phone") || "").trim() || null,
      jobTitle: safePatch.jobTitle, contractType: safePatch.contractType,
      baseWage: Number(form.get("baseWage")),
      hireDate: String(form.get("hireDate") || "") || null,
      employmentStatus: safePatch.employmentStatus,
      notes: String(form.get("notes") || "").trim() || null,
    });
  };
  const content = <div className="space-y-6" dir="rtl"><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><p className="text-xs text-slate-500">إجمالي الموظفين</p><p className="mt-2 text-2xl font-extrabold text-white">{isHrOnline ? (overview.data?.employees ?? []).reduce((sum, row) => sum + Number(row.count), 0) : displayEmployees.length}</p></CardContent></Card><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><p className="text-xs text-slate-500">الموظفون النشطون</p><p className="mt-2 text-2xl font-extrabold text-emerald-300">{isHrOnline ? Number(overview.data?.employees?.find((row) => row.status === "active")?.count ?? 0) : displayEmployees.filter((row) => row.employmentStatus === "active").length}</p></CardContent></Card><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><p className="text-xs text-slate-500">صافي كشوف الرواتب</p><p className="mt-2 text-2xl font-extrabold text-[#F5B800]">{isHrOnline ? money(overview.data?.payroll?.totalNet) + " ش" : "—"}</p></CardContent></Card><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><p className="text-xs text-slate-500">عدد الكشوف</p><p className="mt-2 text-2xl font-extrabold text-white">{isHrOnline ? Number(overview.data?.payroll?.count ?? 0) : "—"}</p></CardContent></Card></div><header className="flex flex-col gap-3 rounded-2xl border border-white/8 bg-[#111823] p-5 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><BriefcaseBusiness className="h-4 w-4" />الموارد البشرية</div><h1 className="mt-2 text-2xl font-extrabold text-white">الموظفون والعمال</h1><p className="mt-1 text-sm text-slate-400">سجل موحد للموظفين مرتبط بالفروع والصلاحيات المالية.</p></div><select aria-label="فرع الموظفين" value={siteId ?? ""} className="h-10 rounded-xl border border-white/10 bg-[#0D1117] px-3 text-sm text-white" disabled><option>{sites.data?.find((site) => site.id === siteId)?.name ?? "جارٍ اختيار الفرع"}</option></select></header>{!isHrOnline ? <p role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-sm leading-6 text-amber-100">وضع عدم الاتصال: يعرض دليل الموظفين نسخة محدودة محفوظة. تبقى الهوية والهاتف والأجور والملاحظات خارج هذا العرض، وتُرسل مسودات الإضافة والتعديل إلى الخادم عند عودة الاتصال.</p> : null}<div className="space-y-4"><Card className="border-white/8 bg-[#111823]"><CardContent className="p-0"><button type="button" aria-expanded={showEmployeeForm} onClick={() => setShowEmployeeForm((open) => !open)} className="flex w-full items-center justify-between gap-3 p-4 text-right"><span className="flex items-center gap-2 font-bold text-white"><Plus className="h-4 w-4 text-[#F5B800]" />إضافة موظف</span><span className="text-xs text-slate-400">{showEmployeeForm ? "إخفاء النموذج" : "إظهار النموذج"}</span></button>{showEmployeeForm ? <form className="grid grid-cols-1 gap-3 border-t border-white/8 p-4 sm:grid-cols-2 xl:grid-cols-3" onSubmit={submit}><Input required name="fullName" placeholder="الاسم الكامل" className="border-white/10 bg-[#0D1117] text-white" /><Input name="identityNo" placeholder="رقم الهوية (اختياري)" className="border-white/10 bg-[#0D1117] text-white" /><Input name="phone" placeholder="رقم الهاتف" className="border-white/10 bg-[#0D1117] text-white" dir="ltr" /><select required name="jobTitle" className="h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-sm text-white"><option value="">المسمى الوظيفي</option>{Object.entries(jobLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select required name="contractType" className="h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-sm text-white">{Object.entries(contractLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><Input required name="baseWage" type="number" min="0" step="0.01" placeholder="الأجر الأساسي بالشيكل" className="border-white/10 bg-[#0D1117] text-white" dir="ltr" /><Input name="hireDate" type="date" className="border-white/10 bg-[#0D1117] text-white" /><select name="linkedUserId" className="h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-sm text-white"><option value="">دون حساب دخول</option>{(isHrOnline ? directory.data ?? [] : []).map((account) => <option key={account.id} value={account.id}>{account.name || account.email}</option>)}</select><Input name="notes" placeholder="ملاحظات" className="border-white/10 bg-[#0D1117] text-white" /><Button disabled={create.isPending || !siteId} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f] sm:col-span-2 xl:col-span-3"><Plus className="ml-2 h-4 w-4" />{create.isPending ? "جارٍ الحفظ…" : "حفظ الموظف"}</Button></form> : null}</CardContent></Card><Card className="border-white/8 bg-[#111823]"><CardContent className="p-0"><div className="border-b border-white/8 p-5"><div className="flex flex-col gap-3 sm:flex-row"><div className="relative flex-1"><Search className="absolute right-3 top-2.5 h-4 w-4 text-slate-500" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث بالاسم أو الهاتف" className="border-white/10 bg-[#0D1117] pr-9 text-white" /></div><select aria-label="حالة الموظف" value={status ?? ""} onChange={(event) => setStatus((event.target.value || undefined) as any)} className="h-10 rounded-md border border-white/10 bg-[#0D1117] px-3 text-sm text-white"><option value="">كل الحالات</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="مسمى الموظف" value={jobTitle ?? ""} onChange={(event) => setJobTitle(event.target.value || undefined)} className="h-10 rounded-md border border-white/10 bg-[#0D1117] px-3 text-sm text-white"><option value="">كل المسميات</option>{Object.entries(jobLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-right text-sm"><thead className="text-xs text-slate-500"><tr><th className="px-5 py-3">الموظف</th><th className="px-4 py-3">المسمى</th><th className="px-4 py-3">العقد</th><th className="px-4 py-3">الأجر</th><th className="px-4 py-3">الحالة</th><th className="px-4 py-3">الهاتف</th><th className="px-4 py-3">إجراء</th></tr></thead><tbody>{displayEmployees.map((employee) => <tr key={employee.id} className="border-t border-white/8"><td className="px-5 py-4"><div className="flex items-center gap-2"><UserRound className="h-4 w-4 text-[#F5B800]" /><span className="font-bold text-white">{employee.fullName}</span></div><span className="mt-1 block text-xs text-slate-500">{employee.identityNo ?? (employee.pendingOffline ? (employee.pendingQueueStatus === "failed" ? "مسودة تعذرت/رُفضت — راجع مركز المزامنة" : "محلي — بانتظار المزامنة") : isHrOnline ? "دون هوية مسجلة" : "غير متاح دون اتصال")}</span></td><td className="px-4 py-4 text-slate-300">{jobLabels[employee.jobTitle]}</td><td className="px-4 py-4 text-slate-300">{contractLabels[employee.contractType]}</td><td className="px-4 py-4 font-bold text-[#F5B800]">{isHrOnline ? money(employee.baseWage) + " ش" : "—"}</td><td className="px-4 py-4"><span className={employee.employmentStatus === "active" ? "rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-bold text-emerald-300" : employee.employmentStatus === "suspended" ? "rounded-full bg-amber-400/10 px-2.5 py-1 text-xs font-bold text-amber-200" : "rounded-full bg-slate-400/10 px-2.5 py-1 text-xs font-bold text-slate-400"}>{statusLabels[employee.employmentStatus]}</span></td><td className="px-4 py-4 text-slate-400" dir="ltr">{employee.phone ?? "—"}</td><td className="px-4 py-4"><Button type="button" size="sm" variant="outline" onClick={() => setEditing(employee)} className="border-white/10 text-slate-200 hover:bg-white/5"><PencilLine className="ml-1 h-3.5 w-3.5" />تعديل</Button></td></tr>)}</tbody></table>{!employees.isLoading && !displayEmployees.length ? <div className="p-10 text-center text-sm text-slate-500">لا توجد سجلات موظفين لهذا الفرع.</div> : null}</div></CardContent></Card></div>
      {editing ? <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(null); }}>
        <Card className="w-full max-w-2xl border-white/10 bg-[#111823] shadow-2xl">
          <CardContent className="p-5">
            <div className="flex items-center justify-between gap-3 border-b border-white/8 pb-4"><div><h2 className="font-extrabold text-white">تعديل بيانات الموظف</h2><p className="mt-1 text-xs text-slate-500">{editing.fullName}</p></div><Button type="button" size="icon" variant="ghost" onClick={() => setEditing(null)} className="text-slate-400 hover:text-white"><X className="h-4 w-4" /></Button></div>
            <form className="mt-5 grid gap-3 md:grid-cols-2" onSubmit={submitEdit}>{!isHrOnline ? <p className="text-sm text-amber-100 md:col-span-2">سيتم حفظ الاسم والمسمى وحالة التوظيف ونوع العقد فقط؛ لا يمكن تعديل بيانات الهوية أو الاتصال أو الأجر دون اتصال.</p> : null}
              <Input required name="fullName" defaultValue={editing.fullName ?? ""} placeholder="الاسم الكامل" className="border-white/10 bg-[#0D1117] text-white" />
              {isHrOnline ? <Input name="identityNo" defaultValue={editing.identityNo ?? ""} placeholder="رقم الهوية" className="border-white/10 bg-[#0D1117] text-white" /> : null}
              {isHrOnline ? <Input name="phone" defaultValue={editing.phone ?? ""} placeholder="رقم الهاتف" className="border-white/10 bg-[#0D1117] text-white" dir="ltr" /> : null}
              <select required name="jobTitle" defaultValue={editing.jobTitle} className="h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-sm text-white">{Object.entries(jobLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>
              <select required name="contractType" defaultValue={editing.contractType} className="h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-sm text-white">{Object.entries(contractLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>
              {isHrOnline ? <Input required name="baseWage" type="number" min="0" step="0.01" defaultValue={editing.baseWage ?? 0} placeholder="الأجر الأساسي" className="border-white/10 bg-[#0D1117] text-white" dir="ltr" /> : null}
              {isHrOnline ? <Input name="hireDate" type="date" defaultValue={editing.hireDate ? String(editing.hireDate).slice(0,10) : ""} className="border-white/10 bg-[#0D1117] text-white" /> : null}
              <select required name="employmentStatus" defaultValue={editing.employmentStatus} className="h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-sm text-white">{Object.entries(statusLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>
              {isHrOnline ? <Input name="notes" defaultValue={editing.notes ?? ""} placeholder="ملاحظات" className="border-white/10 bg-[#0D1117] text-white md:col-span-2" /> : null}
              <div className="flex justify-end gap-2 border-t border-white/8 pt-4 md:col-span-2"><Button type="button" variant="outline" onClick={() => setEditing(null)} className="border-white/10 text-white">إلغاء</Button><Button disabled={update.isPending} className="bg-[#F5B800] font-bold text-[#0D1117]">{update.isPending ? "جارٍ الحفظ…" : "حفظ التعديل"}</Button></div>
            </form>
          </CardContent>
        </Card>
      </div> : null}
    </div>;
  return embedded ? content : <DashboardLayout>{content}</DashboardLayout>;
}
