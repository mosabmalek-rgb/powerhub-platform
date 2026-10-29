import DashboardLayout from "@/components/DashboardLayout";
import { formatReportDate, formatReportPeriod } from "@/lib/report-design-system";
import { downloadReportHtmlAsPdf, escapeHtml } from "@/lib/report-pdf";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { enqueueOfflineHrWork, listOfflineWork, type HrAttendanceUpsertDraft, type HrEmployeeCreateDraft, type QueuedOfflineWork } from "@/lib/offline-work-queue";
import { ClipboardCheck, ChevronDown } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";

const moneyDate = (value: unknown) => formatReportDate(String(value));
export default function AttendancePage({ embedded = false }: { embedded?: boolean }) {
  const sites = trpc.powerhub.sites.list.useQuery(undefined);
  const { branchId: siteId } = useBranchFilter(sites.data);
  const auth = useAuth();
  const { isOnline } = usePowerHubConnectivity();
  const userId = Number(auth.user?.id);
  const tenantId = Number((sites.data as any[] | undefined)?.find((site) => site.id === siteId)?.tenantId);
  const isHrOnline = isOnline && auth.isOnlineAuthenticated && auth.powerHubReachable;
  const [employeeId, setEmployeeId] = useState("");
  const [showAttendanceForm, setShowAttendanceForm] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
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
  const employees = trpc.powerhub.hr.listEmployees.useQuery({ siteId: siteId ?? 0, employmentStatus: "active" }, { enabled: Boolean(siteId) && isHrOnline });
  const offlineDirectory = trpc.powerhub.hr.offlineDirectory.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId) });
  const rows = trpc.powerhub.hr.listAttendance.useQuery({ siteId: siteId ?? 0, fromDate: fromDate || undefined, toDate: toDate || undefined, employeeId: employeeId ? Number(employeeId) : undefined }, { enabled: Boolean(siteId) && isHrOnline });
  const offlineRows = trpc.powerhub.hr.offlineAttendance.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId) });
  const baseEmployees: any[] = isHrOnline && employees.data ? employees.data : (offlineDirectory.data ?? []);
  const pendingEmployeeRows = pendingHrWork.filter((item) => item.kind === "employee_create" && item.status !== "applied")
    .map((item) => {
      const payload = item.payload as HrEmployeeCreateDraft;
      return { id: payload.localEmployeeId, tenantId, siteId, fullName: payload.fullName, jobTitle: payload.jobTitle,
        employmentStatus: payload.employmentStatus, contractType: payload.contractType, versionNo: 1,
        createdAt: new Date(item.createdAt), pendingOffline: true, pendingQueueStatus: item.status };
    });
  const displayEmployees: any[] = [...pendingEmployeeRows,
    ...baseEmployees.filter((employee) => !pendingEmployeeRows.some((pending) => Number(pending.id) === Number(employee.id)))]
    .filter((employee) => employee.employmentStatus === "active");
  const baseAttendanceRows: any[] = (offlineRows.data ?? []).filter((row: any) => !row.attendance.pendingOffline);
  const pendingAttendanceRows = pendingHrWork.filter((item) => item.kind === "attendance_upsert" && item.status !== "applied")
    .map((item) => {
      const payload = item.payload as HrAttendanceUpsertDraft;
      const employee = displayEmployees.find((person) => Number(person.id) === payload.employeeId);
      const previous = baseAttendanceRows.find((row) =>
        Number(row.attendance.employeeId) === payload.employeeId &&
        String(row.attendance.workDate instanceof Date ? row.attendance.workDate.toISOString().slice(0, 10) : row.attendance.workDate).slice(0, 10) === payload.workDate);
      const localId = Number(payload.localAttendanceId ?? (previous?.attendance.id ?? -Math.max(1, item.createdAt)));
      return {
        id: localId, tenantId, siteId,
        attendance: {
          id: localId, tenantId, employeeId: payload.employeeId, siteId,
          workDate: new Date(payload.workDate + "T00:00:00.000Z"),
          regularHours: String(payload.regularHours), overtimeHours: String(payload.overtimeHours),
          absentDays: String(payload.absentDays), notes: null, createdByUserId: null,
          createdAt: previous?.attendance.createdAt ?? new Date(item.createdAt), updatedAt: new Date(item.updatedAt),
          versionNo: payload.expectedVersion ?? previous?.attendance.versionNo ?? 1,
          pendingOffline: true, pendingQueueStatus: item.status,
        },
        employee: {
          id: payload.employeeId, tenantId, siteId: employee?.siteId ?? siteId,
          fullName: employee?.fullName ?? previous?.employee?.fullName ?? ("موظف #" + payload.employeeId),
          jobTitle: employee?.jobTitle ?? previous?.employee?.jobTitle ?? "other",
          employmentStatus: employee?.employmentStatus ?? previous?.employee?.employmentStatus ?? "active",
        },
      };
    });
  const combinedAttendanceRows: any[] = [
    ...baseAttendanceRows.filter((row) => !pendingAttendanceRows.some((pending) =>
      Number(pending.attendance.employeeId) === Number(row.attendance.employeeId) &&
      String(pending.attendance.workDate instanceof Date ? pending.attendance.workDate.toISOString().slice(0, 10) : pending.attendance.workDate).slice(0, 10) ===
        String(row.attendance.workDate instanceof Date ? row.attendance.workDate.toISOString().slice(0, 10) : row.attendance.workDate).slice(0, 10))),
    ...pendingAttendanceRows,
  ];
  const localAttendance = combinedAttendanceRows.filter((row: any) => {
    const raw = row.attendance.workDate;
    const date = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw ?? "").slice(0, 10);
    return (!fromDate || date >= fromDate) && (!toDate || date <= toDate) &&
      (!employeeId || Number(row.attendance.employeeId) === Number(employeeId));
  });
  const pendingAttendanceDisplay = localAttendance.filter((row: any) => row.attendance.pendingOffline);
  const filteredServerAttendance = (rows.data ?? []).filter((row: any) => {
    const raw = row.attendance.workDate;
    const date = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw ?? "").slice(0, 10);
    return (!fromDate || date >= fromDate) && (!toDate || date <= toDate) &&
      (!employeeId || Number(row.attendance.employeeId) === Number(employeeId));
  });
  const displayRows: any[] = isHrOnline && rows.data
    ? [
        ...filteredServerAttendance.filter((row: any) => !pendingAttendanceDisplay.some((pending: any) =>
          Number(pending.attendance.employeeId) === Number(row.attendance.employeeId) &&
          String(pending.attendance.workDate instanceof Date ? pending.attendance.workDate.toISOString().slice(0, 10) : pending.attendance.workDate).slice(0, 10) ===
            String(row.attendance.workDate instanceof Date ? row.attendance.workDate.toISOString().slice(0, 10) : row.attendance.workDate).slice(0, 10))),
        ...pendingAttendanceDisplay,
      ]
    : localAttendance;
  const save = trpc.powerhub.hr.upsertAttendance.useMutation({ onSuccess: () => { void rows.refetch(); toast.success("تم حفظ سجل الحضور."); }, onError: (error) => toast.error(error.message) });
  const exportExcel = async () => { const ExcelJS = await import("exceljs"); const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("الحضور والانصراف", { views: [{ rightToLeft: true }] }); sheet.columns = [{ header: "الموظف", key: "employee", width: 28 }, { header: "التاريخ", key: "date", width: 16 }, { header: "الساعات الاعتيادية", key: "regular", width: 18 }, { header: "الساعات الإضافية", key: "overtime", width: 18 }, { header: "أيام الغياب", key: "absent", width: 16 }, { header: "ملاحظات", key: "notes", width: 30 }]; (displayRows ?? []).forEach((row) => sheet.addRow({ employee: row.employee.fullName, date: moneyDate(row.attendance.workDate), regular: Number(row.attendance.regularHours), overtime: Number(row.attendance.overtimeHours), absent: Number(row.attendance.absentDays), notes: row.attendance.notes ?? "" })); sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } }; const buffer = await workbook.xlsx.writeBuffer(); const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `تقرير-الحضور-${fromDate || "بداية"}-${toDate || "نهاية"}.xlsx`; anchor.click(); URL.revokeObjectURL(url); toast.success("تم تجهيز تقرير الحضور Excel."); };
  const exportPdf = async () => { const rowsData = displayRows ?? []; if (!rowsData.length) return toast.error("لا توجد سجلات حضور ضمن النطاق المحدد."); const root=document.createElement("div"); root.dir="rtl"; root.style.cssText="position:fixed;left:-10000px;top:0;width:1100px;background:#fff;color:#101828;padding:40px;font-family:Arial,sans-serif"; root.innerHTML=`<h1 style="border-bottom:3px solid #F5B800;padding-bottom:14px">تقرير الحضور والانصراف</h1><p>الفترة: ${escapeHtml(formatReportPeriod(fromDate || "", toDate || ""))}</p><table style="width:100%;border-collapse:collapse;text-align:right"><thead><tr style="background:#0D1117;color:#fff"><th>الموظف</th><th>التاريخ</th><th>الساعات الاعتيادية</th><th>الساعات الإضافية</th><th>أيام الغياب</th></tr></thead><tbody>${rowsData.map(row=>`<tr><td>${escapeHtml(row.employee.fullName)}</td><td>${moneyDate(row.attendance.workDate)}</td><td>${row.attendance.regularHours}</td><td>${row.attendance.overtimeHours}</td><td>${row.attendance.absentDays}</td></tr>`).join("")}</tbody></table>`; document.body.appendChild(root); try{await downloadReportHtmlAsPdf(root,`تقرير-الحضور-${fromDate||"بداية"}.pdf`,{landscape:true,title:"تقرير الحضور والانصراف - PowerHub"});toast.success("تم تجهيز تقرير الحضور PDF.");}catch(error){toast.error(error instanceof Error?error.message:"تعذر إنشاء ملف PDF.");}finally{root.remove();} };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!siteId) return;
    const form = new FormData(event.currentTarget);
    const selectedEmployeeId = Number(form.get("employeeId"));
    const workDate = String(form.get("workDate") || "");
    const regularHours = Number(form.get("regularHours"));
    const overtimeHours = Number(form.get("overtimeHours"));
    const absentDays = Number(form.get("absentDays"));
    const notes = String(form.get("notes") || "").trim() || null;
    if (!selectedEmployeeId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate) ||
        !Number.isFinite(regularHours) || regularHours < 0 || regularHours > 24 ||
        !Number.isFinite(overtimeHours) || overtimeHours < 0 || overtimeHours > 24 ||
        !Number.isFinite(absentDays) || absentDays < 0 || absentDays > 1) {
      toast.error("راجع تاريخ الحضور والساعات وقيمة الغياب.");
      return;
    }
    if (isHrOnline) {
      save.mutate({ siteId, employeeId: selectedEmployeeId, workDate, regularHours, overtimeHours, absentDays, notes: notes ?? undefined });
      return;
    }
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(tenantId) || tenantId < 1) {
      toast.error("لا تتوفر هوية المستخدم ونطاق الشركة المحفوظان؛ لم تُحفظ المسودة.");
      return;
    }
    try {
      const existing = (offlineRows.data ?? []).find((row: any) => {
        const date = row.attendance.workDate instanceof Date
          ? row.attendance.workDate.toISOString().slice(0, 10)
          : String(row.attendance.workDate ?? "").slice(0, 10);
        return Number(row.attendance.employeeId) === selectedEmployeeId && date === workDate;
      }) as any;
      if (existing?.attendance.pendingOffline) {
        // The outbox will coalesce a still-pending update for the same employee/date.
      }
      const pendingCreate = selectedEmployeeId < 0
        ? (await listOfflineWork({ userId, siteId })).find((item) => item.kind === "employee_create" &&
            item.status !== "applied" && (item.payload as HrEmployeeCreateDraft).localEmployeeId === selectedEmployeeId)
        : undefined;
      const localAttendanceId = Number(existing?.attendance.id ?? -Date.now());
      const work = await enqueueOfflineHrWork({
        userId, tenantId, siteId, kind: "attendance_upsert",
        dependsOn: pendingCreate ? [pendingCreate.clientOperationId] : [],
        payload: {
          employeeId: selectedEmployeeId, workDate,
          expectedVersion: existing && !existing.attendance.pendingOffline && Number(existing.attendance.id) > 0 &&
            Number(existing.attendance.versionNo) > 0 ? Number(existing.attendance.versionNo) : null,
          regularHours, overtimeHours, absentDays, notes,
          localAttendanceId,
        },
      });

      await refreshPendingHrWork();
      setShowAttendanceForm(false);
      toast.success("حُفظ سجل الحضور محليًا بانتظار المزامنة. لم يُعتمد على الخادم بعد.");
      void work;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذر حفظ سجل الحضور محليًا.");
    }
  };
  const content = <div dir="rtl" className="space-y-6"><header className="rounded-2xl border border-white/8 bg-[#111823] p-5"><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><ClipboardCheck className="h-4 w-4" />الحضور والانصراف</div><h1 className="mt-2 text-2xl font-extrabold text-white">سجل الدوام اليدوي</h1><p className="mt-1 text-sm text-slate-400">يسجل المحاسب الساعات الاعتيادية والإضافية وأيام الغياب بالفرع المحدد، وتستخدم البيانات عند تطوير احتساب الرواتب.</p></header>{!isHrOnline ? <p role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-sm leading-6 text-amber-100">وضع عدم الاتصال: تُحفظ سجلات الدوام كمسودات محلية، وتُزال الملاحظات ومعرّفات المنفذين من النسخة المخزنة. سيُراجع الخادم النسخة والتعارضات قبل تثبيت السجل.</p> : null}<div className="space-y-4"><Card className="border-white/8 bg-[#111823]"><CardContent className="p-0"><button type="button" aria-expanded={showAttendanceForm} onClick={() => setShowAttendanceForm((open) => !open)} className="flex w-full items-center justify-between gap-3 p-4 text-right"><span className="font-bold text-white">إضافة أو تحديث يوم</span><span className="flex items-center gap-2 text-xs text-slate-400">{showAttendanceForm ? "إخفاء النموذج" : "إظهار النموذج"}<ChevronDown className={`h-4 w-4 transition-transform ${showAttendanceForm ? "rotate-180" : ""}`} /></span></button>{showAttendanceForm ? <form onSubmit={submit} className="grid grid-cols-1 gap-3 border-t border-white/8 p-4 sm:grid-cols-2 lg:grid-cols-3"><div><label htmlFor="attendance-employee" className="mb-1.5 block text-sm font-bold text-slate-200">الموظف</label><select id="attendance-employee" required name="employeeId" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} className="h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-sm text-white"><option value="">اختر الموظف</option>{displayEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}</select><p className="mt-1.5 text-xs leading-5 text-slate-400">اختر الموظف الذي تريد تسجيل دوامه في الفرع المحدد. اختيار الموظف نفسه مع تاريخ مسجل يحدّث سجل ذلك اليوم.</p></div><div><label htmlFor="attendance-work-date" className="mb-1.5 block text-sm font-bold text-slate-200">تاريخ الدوام</label><Input id="attendance-work-date" required name="workDate" type="date" className="border-white/10 bg-[#0D1117] text-white" /><p className="mt-1.5 text-xs leading-5 text-slate-400">اليوم الذي يخصه السجل، وليس تاريخ إدخال البيانات. إذا وُجد سجل للموظف في هذا التاريخ فسيُحدّث بدل إنشاء سجل يومي مكرر.</p></div><div><label htmlFor="attendance-regular-hours" className="mb-1.5 block text-sm font-bold text-slate-200">الساعات الاعتيادية</label><Input id="attendance-regular-hours" name="regularHours" type="number" min="0" max="24" step="0.25" defaultValue="8" placeholder="الساعات الاعتيادية" className="border-white/10 bg-[#0D1117] text-white" dir="ltr" /><p className="mt-1.5 text-xs leading-5 text-slate-400">عدد ساعات العمل العادية في هذا اليوم. القيمة الافتراضية 8 ساعات، ويمكن إدخال ربع ساعة مثل 7.5 أو 7.75. أدخل 0 إذا لم يعمل ساعات اعتيادية.</p></div><div><label htmlFor="attendance-overtime-hours" className="mb-1.5 block text-sm font-bold text-slate-200">الساعات الإضافية</label><Input id="attendance-overtime-hours" name="overtimeHours" type="number" min="0" max="24" step="0.25" defaultValue="0" placeholder="ساعات إضافية" className="border-white/10 bg-[#0D1117] text-white" dir="ltr" /><p className="mt-1.5 text-xs leading-5 text-slate-400">ساعات العمل التي تتجاوز الدوام الاعتيادي وتُسجّل منفصلة. القيمة الافتراضية 0، والحد الأعلى 24 ساعة لليوم.</p></div><div><label htmlFor="attendance-absent-days" className="mb-1.5 block text-sm font-bold text-slate-200">أيام الغياب</label><Input id="attendance-absent-days" name="absentDays" type="number" min="0" max="1" step="0.5" defaultValue="0" placeholder="أيام الغياب" className="border-white/10 bg-[#0D1117] text-white" dir="ltr" /><p className="mt-1.5 text-xs leading-5 text-slate-400">جزء اليوم الذي تغيّب فيه الموظف: 0 لا غياب، 0.5 نصف يوم، 1 يوم كامل. لا تتجاوز القيمة يومًا واحدًا في سجل اليوم.</p></div><div><label htmlFor="attendance-notes" className="mb-1.5 block text-sm font-bold text-slate-200">ملاحظات (اختياري)</label><Input id="attendance-notes" name="notes" placeholder="مثال: إجازة معتمدة أو تكليف إضافي" className="border-white/10 bg-[#0D1117] text-white" /><p className="mt-1.5 text-xs leading-5 text-slate-400">اكتب توضيحًا مختصرًا عند الحاجة، مثل سبب الغياب أو التكليف الإضافي. اتركه فارغًا إن لم توجد ملاحظات.</p></div><Button disabled={save.isPending || !siteId} className="w-full bg-[#F5B800] font-bold text-[#0D1117] sm:col-span-2 lg:col-span-3">{save.isPending ? "جارٍ الحفظ…" : "حفظ سجل الدوام"}</Button></form> : null}</CardContent></Card><Card className="border-white/8 bg-[#111823]"><CardContent className="p-0"><div className="flex flex-wrap gap-3 border-b border-white/8 p-5"><p className="w-full text-xs leading-5 text-slate-400">فلاتر التقرير: حدّد تاريخ البداية والنهاية لتقييد السجلات، ويمكن اختيار موظف بعينه أو «كل الموظفين». تُستخدم النتائج الظاهرة للتصدير إلى Excel أو PDF.</p><Button variant="outline" onClick={exportExcel} disabled={!rows.data?.length} className="border-white/10 text-white"><Download className="ml-2 h-4 w-4" />Excel</Button><Button variant="outline" onClick={exportPdf} disabled={!rows.data?.length} className="border-white/10 text-white"><Download className="ml-2 h-4 w-4" />PDF</Button><Input value={fromDate} onChange={(event) => setFromDate(event.target.value)} type="date" aria-label="من تاريخ" className="w-auto border-white/10 bg-[#0D1117] text-white" /><Input value={toDate} onChange={(event) => setToDate(event.target.value)} type="date" aria-label="إلى تاريخ" className="w-auto border-white/10 bg-[#0D1117] text-white" /><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} aria-label="تصفية الموظف" className="h-10 rounded-md border border-white/10 bg-[#0D1117] px-3 text-sm text-white"><option value="">كل الموظفين</option>{employees.data?.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}</select></div><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-right text-sm"><thead className="text-xs text-slate-500"><tr><th className="px-5 py-3">الموظف</th><th className="px-4 py-3">التاريخ</th><th className="px-4 py-3">اعتيادي</th><th className="px-4 py-3">إضافي</th><th className="px-4 py-3">غياب</th></tr></thead><tbody>{displayRows.map((row) => <tr key={row.attendance.id} className="border-t border-white/8"><td className="px-5 py-4 font-bold text-white">{row.employee.fullName}{row.attendance.pendingOffline ? <span className="mt-1 block text-xs font-normal text-amber-200">{row.attendance.pendingQueueStatus === "failed" ? "تعذرت/رُفضت — راجع مركز المزامنة" : "محلي — بانتظار المزامنة"}</span> : null}</td><td className="px-4 py-4 text-slate-300">{moneyDate(row.attendance.workDate)}</td><td className="px-4 py-4 text-slate-300">{row.attendance.regularHours} س</td><td className="px-4 py-4 text-[#F5B800]">{row.attendance.overtimeHours} س</td><td className="px-4 py-4 text-rose-300">{row.attendance.absentDays} يوم</td></tr>)}</tbody></table>{!rows.isLoading && !displayRows.length ? <div className="p-10 text-center text-sm text-slate-500">لا توجد سجلات حضور للموظف أو الفترة أو الفرع المحدد.</div> : null}</div></CardContent></Card></div></div>;
  return embedded ? content : <DashboardLayout>{content}</DashboardLayout>;
}
