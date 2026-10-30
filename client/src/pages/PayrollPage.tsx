import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { can } from "@shared/powerhub-rbac";
import { CheckCircle2, CircleDollarSign, Download, FilePlus2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { buildPayrollDetailRow } from "@/lib/payroll-report";
import { downloadReportHtmlAsPdf, escapeHtml } from "@/lib/report-pdf";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { isExplicitAuthorizationDenial } from "@/lib/offline-query-errors";
import { clearOfflineHrProjectionCacheForSite } from "@/lib/offline-query-cache";
import { getSupabaseSession } from "@/lib/supabase";
import { enqueueOfflineHrWork, listOfflineWork, subscribeOfflineWorkQueueChanges, type HrEmployeeCreateDraft, type HrPayrollDraftPayload } from "@/lib/offline-work-queue";

const statusLabels: Record<string, string> = { draft: "مسودة", approved: "معتمد", paid: "مصروف", cancelled: "ملغى" };
const money = (value: unknown) => new Intl.NumberFormat("ar-PS", { maximumFractionDigits: 2 }).format(Number(value ?? 0));

export default function PayrollPage({ embedded = false }: { embedded?: boolean }) {
  const utils = trpc.useUtils();
  const sites = trpc.powerhub.sites.list.useQuery(undefined);
  const { branchId: siteId } = useBranchFilter(sites.data);
  const auth = useAuth();
  const { isOnline } = usePowerHubConnectivity();
  const userId = Number(auth.user?.id);
  const tenantId = Number((sites.data as any[] | undefined)?.find((site) => site.id === siteId)?.tenantId);
  const isHrOnline = isOnline && auth.isOnlineAuthenticated && auth.powerHubReachable;
  const access = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId) && isHrOnline });
  const hasPayrollRole = (access.data?.role === "owner" || access.data?.role === "accountant") && can(access.data?.role, "managePayroll", access.data?.permissions);
  const period = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const employees = trpc.powerhub.hr.listEmployees.useQuery({ siteId: siteId ?? 0, employmentStatus: "active" }, { enabled: Boolean(siteId) && isHrOnline });
  const offlineDirectory = trpc.powerhub.hr.offlineDirectory.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId) });
  const runs = trpc.powerhub.hr.listPayrollRuns.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId) && isHrOnline });
  const offlineRuns = trpc.powerhub.hr.offlinePayrollRuns.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId) });
  const payrollDataDenied = [access, employees, offlineDirectory, runs, offlineRuns].some((query) =>
    query.isError && isExplicitAuthorizationDenial(query.error));
  const hasLivePayrollRuns = Boolean(isHrOnline && runs.data !== undefined &&
    runs.isFetchedAfterMount && !runs.isError);
  const isShowingCachedPayrollRuns = !payrollDataDenied && !hasLivePayrollRuns && offlineRuns.data !== undefined;
  const isShowingStalePayrollRuns = !payrollDataDenied && !hasLivePayrollRuns &&
    offlineRuns.data === undefined && runs.data !== undefined;
  useEffect(() => {
    if (!payrollDataDenied || !siteId || !Number.isSafeInteger(userId) || userId < 1) return;
    let active = true;
    void getSupabaseSession().then((session) => {
      if (active && session?.user.id) void clearOfflineHrProjectionCacheForSite(session.user.id, siteId, ["offlineDirectory", "offlinePayrollRuns"]);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [payrollDataDenied, siteId, userId]);
  const [pendingDrafts, setPendingDrafts] = useState<any[]>([]);
  useEffect(() => {
    if (payrollDataDenied || !Number.isSafeInteger(userId) || userId < 1 || !siteId) { setPendingDrafts([]); return; }
    let active = true;
    const loadPendingDrafts = () => {
      void listOfflineWork({ userId, siteId }).then((items) => {
        if (!active) return;
        setPendingDrafts(items.filter((item) => item.kind === "payroll_draft" && item.status !== "applied")
          .map((item) => ({ id: -Math.max(1, item.createdAt), period: (item.payload as HrPayrollDraftPayload).period,
            status: "draft", totalGross: null, totalDeductions: null, totalNet: null, pendingOffline: true,
            queueStatus: item.status, createdAt: new Date(item.createdAt) })));
      }).catch(() => { if (active) setPendingDrafts([]); });
    };
    const unsubscribe = subscribeOfflineWorkQueueChanges({ userId, siteId }, loadPendingDrafts);
    loadPendingDrafts();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [userId, siteId, runs.dataUpdatedAt, payrollDataDenied]);
  const serverRuns: any[] = payrollDataDenied ? [] : hasLivePayrollRuns
    ? runs.data ?? [] : offlineRuns.data ?? (isHrOnline ? runs.data ?? [] : []);
  const displayRuns: any[] = payrollDataDenied ? [] : [
    ...pendingDrafts.filter((draft) => !serverRuns.some((run) => run.period === draft.period)),
    ...serverRuns,
  ];
  const displayEmployees: any[] = payrollDataDenied ? [] : (isHrOnline && employees.data ? employees.data : (offlineDirectory.data ?? []).filter((employee) => employee.employmentStatus === "active"));
  const accounts = trpc.powerhub.companyAccounts.list.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId) && isHrOnline }); const branding = trpc.powerhub.reportBranding.get.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId) && isHrOnline });
  const [showDetails, setShowDetails] = useState(false);
  const [accountId, setAccountId] = useState(""); const [detailsRunId, setDetailsRunId] = useState<number | null>(null); const details = trpc.powerhub.hr.getPayrollDetails.useQuery({ siteId: siteId ?? 0, payrollRunId: detailsRunId ?? 0 }, { enabled: Boolean(isHrOnline && siteId && detailsRunId) });
  const detailsAccessDenied = details.isError && isExplicitAuthorizationDenial(details.error);
  const canManagePayrollRuns = !payrollDataDenied && !detailsAccessDenied && hasPayrollRole;
  const accountAccessDenied = accounts.isError && isExplicitAuthorizationDenial(accounts.error);
  const safePayrollDetails = detailsAccessDenied ? undefined : details.data;
  const create = trpc.powerhub.hr.createPayrollDraft.useMutation({ onSuccess: () => { void runs.refetch(); toast.success("تم إنشاء مسودة كشف الرواتب."); }, onError: (error) => toast.error(error.message) });
  const approve = trpc.powerhub.hr.approvePayroll.useMutation({ onSuccess: () => { void runs.refetch(); toast.success("تم اعتماد كشف الرواتب."); }, onError: (error) => toast.error(error.message) });
  const cancelDraft = trpc.powerhub.hr.cancelPayrollDraft.useMutation({ onSuccess: async () => { await runs.refetch(); toast.success("تم إلغاء المسودة وتحرير حجوزات السلف."); }, onError: (error) => toast.error(error.message) });
  const pay = trpc.powerhub.hr.payPayroll.useMutation({ onSuccess: () => { void utils.powerhub.hr.listPayrollRuns.invalidate(); toast.success("تم صرف الرواتب وتسجيل المصروف وحركة الحساب."); }, onError: (error) => toast.error(error.message) });
  const exportExcel = async () => { const ExcelJS = await import("exceljs"); const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Payroll"); sheet.columns = [{ header: "الفترة", key: "period", width: 16 }, { header: "الموظف", key: "employee", width: 28 }, { header: "المسمى", key: "jobTitle", width: 18 }, { header: "الأساسي", key: "base", width: 16 }, { header: "المكافآت", key: "extra", width: 16 }, { header: "خصم السلف", key: "advance", width: 16 }, { header: "خصومات أخرى", key: "other", width: 16 }, { header: "الصافي", key: "net", width: 16 }]; const selectedRun = (displayRuns ?? []).find((run) => run.id === detailsRunId); if (selectedRun && safePayrollDetails?.length) safePayrollDetails?.forEach((row) => sheet.addRow(buildPayrollDetailRow(selectedRun.period, row))); else (displayRuns ?? []).forEach((run) => sheet.addRow({ period: run.period, employee: "ملخص الكشف", base: Number(run.totalGross), other: Number(run.totalDeductions), net: Number(run.totalNet) })); sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } }; const buffer = await workbook.xlsx.writeBuffer(); const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `كشوف-الرواتب-${period}.xlsx`; anchor.click(); URL.revokeObjectURL(url); toast.success("تم تجهيز ملف Excel."); };
  const exportPdf = async () => { const selectedRun=(displayRuns??[]).find((run)=>run.id===detailsRunId); const root=document.createElement("div"); root.dir="rtl"; root.style.cssText="position:fixed;left:-10000px;top:0;width:1100px;background:#fff;color:#101828;padding:48px;font-family:Arial,sans-serif"; const rows=selectedRun&&safePayrollDetails?.length?safePayrollDetails?.map((row)=>{const item=buildPayrollDetailRow(selectedRun.period,row);return `<tr><td>${escapeHtml(item.employee)}</td><td>${escapeHtml(item.jobTitle)}</td><td>${money(item.base)} شيكل</td><td>${money(item.extra)} شيكل</td><td>${money(item.advance)} شيكل</td><td>${money(item.other)} شيكل</td><td><strong>${money(item.net)} شيكل</strong></td></tr>`;}).join(""):(displayRuns??[]).map((run)=>`<tr><td colspan="2">${escapeHtml(run.period)}</td><td>${run.pendingOffline ? "—" : money(run.totalGross) + " ش"}يكل</td><td colspan="2">${run.pendingOffline ? "—" : money(run.totalDeductions) + " ش"}يكل</td><td colspan="2">${run.pendingOffline ? "يُحسب عند المزامنة" : money(run.totalNet) + " ش"}يكل</td></tr>`).join(""); root.innerHTML=`<h1 style="border-bottom:3px solid #F5B800;padding-bottom:14px">${escapeHtml(branding.data?.companyName??"PowerHub")}</h1><p>كشف الرواتب الشهري — ${escapeHtml(selectedRun?.period ?? period)}</p><table style="width:100%;border-collapse:collapse;text-align:right"><thead><tr style="background:#0D1117;color:#fff"><th>الموظف</th><th>المسمى</th><th>الأساسي</th><th>المكافآت</th><th>خصم السلف</th><th>خصومات أخرى</th><th>الصافي</th></tr></thead><tbody>${rows}</tbody></table>`; document.body.appendChild(root); try { await downloadReportHtmlAsPdf(root,`كشف-رواتب-${escapeHtml(selectedRun?.period ?? period)}.pdf`,{landscape:true,title:"كشف الرواتب الشهري - PowerHub"}); toast.success("تم تجهيز PDF عربي منسق."); } catch(error){toast.error(error instanceof Error?error.message:"تعذر إنشاء ملف PDF.");} finally{root.remove();} };
  const makeDraft = async () => {
    if (payrollDataDenied) return toast.error("رفض الخادم صلاحية الوصول إلى كشوف الرواتب؛ لم تُنفّذ العملية.");
    if (isHrOnline && !canManagePayrollRuns) return toast.error("ليس لديك صلاحية إدارة كشوف الرواتب.");
    if (!siteId || !displayEmployees.length) return toast.error("أضف موظفين نشطين أولاً.");
    const items = displayEmployees.map((employee) => ({ employeeId: Number(employee.id), extraAmount: 0, advanceDeduction: 0, otherDeduction: 0 }));
    if (isHrOnline) {
      create.mutate({ siteId, period, items });
      return;
    }
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(tenantId) || tenantId < 1) {
      toast.error("لا تتوفر هوية المستخدم ونطاق الشركة المحفوظان؛ لم تُحفظ المسودة.");
      return;
    }
    try {
      const existingQueue = await listOfflineWork({ userId, siteId });
      const dependencies = existingQueue.filter((item) => item.kind === "employee_create" && item.status !== "applied")
        .filter((item) => items.some((line) => line.employeeId === (item.payload as HrEmployeeCreateDraft).localEmployeeId))
        .map((item) => item.clientOperationId);
      const queued = await enqueueOfflineHrWork({
        userId, tenantId, siteId, kind: "payroll_draft", dependsOn: dependencies,
        payload: { period, items },
      });
      setPendingDrafts((current) => [{ id: -Math.max(1, queued.createdAt), period, status: "draft",
        totalGross: null, totalDeductions: null, totalNet: null, pendingOffline: true, queueStatus: queued.status,
        createdAt: new Date(queued.createdAt) }, ...current.filter((item) => item.period !== period)]);
      toast.success("حُفظت مسودة طلب الرواتب محليًا. سيحسب الخادم الأجور وخصومات السلف عند المزامنة؛ لم يُنشأ كشف أو يُصرف مال بعد.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذر حفظ مسودة الرواتب محليًا.");
    }
  };
  const content = <div className="space-y-6" dir="rtl"><header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/8 bg-[#111823] p-5"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><CircleDollarSign className="h-4 w-4" />الرواتب والأجور</div><h1 className="mt-2 text-2xl font-extrabold text-white">كشف الرواتب الشهري</h1><p className="mt-1 text-sm text-slate-400">العملة المعتمدة: الشيكل. لا يتحول الكشف إلى مصروف إلا بعد الاعتماد والصرف.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={exportExcel} disabled={!displayRuns.length} className="border-white/10 text-white"><Download className="ml-2 h-4 w-4" />Excel</Button><Button variant="outline" onClick={exportPdf} disabled={!displayRuns.length} className="border-white/10 text-white"><Download className="ml-2 h-4 w-4" />PDF</Button>{(canManagePayrollRuns || (!isHrOnline && Boolean(siteId && userId > 0))) ? <Button onClick={makeDraft} disabled={create.isPending || !siteId} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><FilePlus2 className="ml-2 h-4 w-4" />{isHrOnline ? "إنشاء مسودة " : "حفظ طلب مسودة "}{period}</Button> : null}</div></header>{payrollDataDenied ? <p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/5 p-3 text-sm leading-6 text-rose-100">رفض الخادم صلاحية الوصول إلى كشوف الرواتب؛ أُخفيت اللقطات المحلية والبدائل. بقيت المسودات المعلّقة في مركز المزامنة للمراجعة.</p> : detailsAccessDenied ? <p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/5 p-3 text-sm leading-6 text-rose-100">رفض الخادم صلاحية عرض تفاصيل كشف الرواتب؛ أُخفيت تفاصيل النسخة السابقة.</p> : null}{isShowingCachedPayrollRuns ? <p role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-sm leading-6 text-amber-100">تُعرض آخر نسخة محلية من ملخصات الرواتب المتزامنة عبر Delta. الملخص ليس تفاصيل كشف كاملة ولا يمنح صلاحية اعتماد أو إلغاء أو صرف؛ هذه الإجراءات تتطلب اتصالًا وتحققًا خادميًا.</p> : null}{isShowingStalePayrollRuns ? <p role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-sm leading-6 text-amber-100">تعذر التحقق من ملخصات الرواتب عبر Delta ولا توجد قراءة خادمية حديثة من هذه الصفحة؛ تُعرض آخر نتيجة في الذاكرة للقراءة فقط. أوقفنا التفاصيل والاعتماد والإلغاء والصرف حتى نجاح القراءة الحية.</p> : null}{!isHrOnline && !payrollDataDenied ? <p role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-sm leading-6 text-amber-100">وضع عدم الاتصال: يمكنك حفظ طلب مسودة رواتب محليًا. لن تُحسب الأجور أو تُحجز السلف أو يُعتمد الكشف قبل تحقّق الخادم، وأزرار الاعتماد والإلغاء والصرف متوقفة دون اتصال.</p> : null}<Card className="border-white/8 bg-[#111823]"><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-right text-sm"><thead className="text-xs text-slate-500"><tr><th className="px-5 py-3">الفترة</th><th className="px-4 py-3">الإجمالي</th><th className="px-4 py-3">الخصومات</th><th className="px-4 py-3">الصافي</th><th className="px-4 py-3">الحالة</th><th className="px-4 py-3">الإجراء</th></tr></thead><tbody>{displayRuns.map((run) => <tr key={run.id} className="border-t border-white/8"><td className="px-5 py-4 font-bold text-white">{run.period}</td><td className="px-4 py-4 text-slate-300">{run.pendingOffline ? "—" : money(run.totalGross) + " ش"}</td><td className="px-4 py-4 text-rose-300">{run.pendingOffline ? "—" : money(run.totalDeductions) + " ش"}</td><td className="px-4 py-4 font-bold text-[#F5B800]">{run.pendingOffline ? "يُحسب عند المزامنة" : money(run.totalNet) + " ش"}</td><td className="px-4 py-4"><span className="rounded-full bg-white/8 px-2.5 py-1 text-xs font-bold text-slate-200">{run.pendingOffline ? (run.queueStatus === "conflict" ? "تعارض — مراجعة مطلوبة" : run.queueStatus === "failed" ? "تعذر الإرسال — راجع الطابور" : "بانتظار المزامنة") : statusLabels[run.status]}</span></td><td className="px-4 py-4"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!hasLivePayrollRuns || run.pendingOffline} onClick={() => setDetailsRunId(run.id)} className="border-white/10 text-white">تفاصيل</Button>{canManagePayrollRuns && hasLivePayrollRuns && !run.pendingOffline && run.status === "draft" ? <Button size="sm" disabled={!isHrOnline} onClick={() => approve.mutate({ siteId: siteId!, payrollRunId: run.id })} className="bg-emerald-600 text-white"><CheckCircle2 className="ml-1 h-3.5 w-3.5" />اعتماد</Button> : null}{canManagePayrollRuns && hasLivePayrollRuns && !run.pendingOffline && run.status === "draft" ? <Button size="sm" variant="outline" disabled={!isHrOnline || cancelDraft.isPending} onClick={() => { if (window.confirm("سيُلغى هذا الكشف وتُحرر حجوزات السلف المرتبطة به. هل تريد المتابعة؟")) cancelDraft.mutate({ siteId: siteId!, payrollRunId: run.id }); }} className="border-rose-500/30 text-rose-300"><XCircle className="ml-1 h-3.5 w-3.5" />إلغاء المسودة</Button> : null}{canManagePayrollRuns && hasLivePayrollRuns && !run.pendingOffline && run.status === "approved" ? <div className="flex gap-2"><select aria-label="حساب صرف الراتب" value={accountId} onChange={(event) => setAccountId(event.target.value)} className="h-8 rounded-md border border-white/10 bg-[#0D1117] px-2 text-xs text-white"><option value="">حساب الصرف</option>{(accountAccessDenied ? [] : accounts.data ?? []).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select><Button size="sm" disabled={!isHrOnline || accountAccessDenied || !accountId || pay.isPending} onClick={() => pay.mutate({ siteId: siteId!, payrollRunId: run.id, accountId: Number(accountId) })} className="bg-[#F5B800] text-[#0D1117]">صرف</Button></div> : null}</div></td></tr>)}</tbody></table>{!runs.isLoading && !displayRuns.length ? <div className="p-10 text-center text-sm text-slate-500">لا توجد كشوف رواتب بعد.</div> : null}</div></CardContent></Card></div>;
  return embedded ? content : <DashboardLayout>{content}</DashboardLayout>;
}
