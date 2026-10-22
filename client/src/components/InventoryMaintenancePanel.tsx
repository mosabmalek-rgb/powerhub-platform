import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { CalendarClock, ClipboardList, Download, Loader2, PackagePlus, RefreshCw, Wrench } from "lucide-react";

type OrderType = "breakdown" | "preventive" | "inspection" | "repair" | "other";
type OrderStatus = "scheduled" | "new" | "in_progress" | "waiting_for_parts" | "completed" | "cancelled";
type Priority = "low" | "normal" | "high" | "urgent";
const statusLabels: Record<OrderStatus, string> = { scheduled: "مجدول", new: "جديد", in_progress: "قيد التنفيذ", waiting_for_parts: "بانتظار قطع الغيار", completed: "مكتمل", cancelled: "ملغي" };
const priorityLabels: Record<Priority, string> = { low: "منخفضة", normal: "عادية", high: "مرتفعة", urgent: "عاجلة" };
const orderTypeLabels: Record<OrderType, string> = { breakdown: "عطل", preventive: "صيانة وقائية", inspection: "فحص", repair: "إصلاح", other: "أخرى" };
const alertLabels: Record<string, string> = { due_soon: "اقترب الاستحقاق", overdue: "متأخرة", resolved: "تمت المعالجة" };
const money = (value: unknown) => new Intl.NumberFormat("ar-PS", { style: "currency", currency: "ILS", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value ?? 0));
const openStatuses: OrderStatus[] = ["new", "scheduled", "in_progress", "waiting_for_parts"];
const operationKey = (prefix: string) => prefix + "-" + crypto.randomUUID();
const localDateInput = (date: Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
const csvCell = (value: unknown) => {
  let s = String(value ?? "");
  const first = s.trimStart()[0];
  if (first === "=" || first === "+" || first === "-" || first === "@") s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"' ;
};

export default function InventoryMaintenancePanel({
  siteId, isAuthenticated, canManageMaintenance, canIssueInventory, canManageExpenses,
}: { siteId: number; isAuthenticated: boolean; canManageMaintenance: boolean; canIssueInventory: boolean; canManageExpenses: boolean }) {
  const utils = trpc.useUtils();
  const evaluatedSiteRef = useRef<number | null>(null);
  const [generatorId, setGeneratorId] = useState("");
  const [orderType, setOrderType] = useState<OrderType>("breakdown");
  const [preventivePlanId, setPreventivePlanId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [filter, setFilter] = useState<OrderStatus | "">("");
  const [planGeneratorId, setPlanGeneratorId] = useState("");
  const [planTitle, setPlanTitle] = useState("");
  const [planDescription, setPlanDescription] = useState("");
  const [intervalDays, setIntervalDays] = useState("30");
  const [intervalHours, setIntervalHours] = useState("");
  const [nextDueDate, setNextDueDate] = useState(() => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  const [nextDueHours, setNextDueHours] = useState("");
  const [selectedPartsOrderId, setSelectedPartsOrderId] = useState("");
  const [partItemId, setPartItemId] = useState("");
  const [partWarehouseId, setPartWarehouseId] = useState("");
  const [partQuantity, setPartQuantity] = useState("1");
  const [partNotes, setPartNotes] = useState("");
  const [orderGeneratorFilter, setOrderGeneratorFilter] = useState("");
  const [reportGeneratorId, setReportGeneratorId] = useState("");
  const [reportFromDate, setReportFromDate] = useState(() => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; });
  const [reportToDate, setReportToDate] = useState(() => localDateInput(new Date()));

  const generators = trpc.powerhub.generators.list.useQuery({ siteId }, { enabled: Boolean(siteId && isAuthenticated && canManageMaintenance), staleTime: 30_000 });
  const orders = trpc.powerhub.maintenance.listWorkOrders.useQuery({ siteId, generatorId: orderGeneratorFilter ? Number(orderGeneratorFilter) : undefined, status: filter || undefined, limit: 200 }, { enabled: Boolean(siteId && isAuthenticated && canManageMaintenance), staleTime: 15_000 });
  const maintenanceReport = trpc.powerhub.maintenance.reportByGenerator.useQuery(
    { siteId, fromDate: reportFromDate, toDate: reportToDate, generatorId: reportGeneratorId ? Number(reportGeneratorId) : undefined },
    { enabled: Boolean(siteId && isAuthenticated && canManageMaintenance && reportFromDate && reportToDate && reportFromDate <= reportToDate), staleTime: 30_000 },
  );
  const plans = trpc.powerhub.maintenance.listPreventivePlans.useQuery({ siteId, generatorId: planGeneratorId ? Number(planGeneratorId) : undefined }, { enabled: Boolean(siteId && isAuthenticated && canManageMaintenance), staleTime: 15_000 });
  const items = trpc.powerhub.inventory.listItems.useQuery({ siteId, includeInactive: false }, { enabled: Boolean(siteId && isAuthenticated && canIssueInventory), staleTime: 30_000 });
  const warehouses = trpc.powerhub.inventory.listWarehouses.useQuery({ siteId, includeInactive: false }, { enabled: Boolean(siteId && isAuthenticated && canIssueInventory), staleTime: 30_000 });
  const selectedPartsOrder = orders.data?.find((order) => order.work_order_id === Number(selectedPartsOrderId));
  const parts = trpc.powerhub.maintenance.listParts.useQuery({ siteId, workOrderId: Number(selectedPartsOrderId) || 0 }, { enabled: Boolean(siteId && isAuthenticated && canManageMaintenance && Number(selectedPartsOrderId) > 0), staleTime: 15_000 });

  const create = trpc.powerhub.maintenance.createWorkOrder.useMutation({
    onSuccess: async () => { toast.success("تم إنشاء أمر الصيانة."); setTitle(""); setDescription(""); setGeneratorId(""); setPreventivePlanId(""); setPriority("normal"); setOrderType("breakdown"); await Promise.all([utils.powerhub.maintenance.listWorkOrders.invalidate(), utils.powerhub.maintenance.listPreventivePlans.invalidate()]); },
    onError: (error) => toast.error(error.message || "تعذر إنشاء أمر الصيانة."),
  });
  const transition = trpc.powerhub.maintenance.transitionWorkOrder.useMutation({
    onSuccess: async () => { toast.success("تم تحديث حالة أمر الصيانة."); await Promise.all([utils.powerhub.maintenance.listWorkOrders.invalidate(), utils.powerhub.maintenance.listPreventivePlans.invalidate(), utils.powerhub.maintenance.listParts.invalidate()]); },
    onError: (error) => toast.error(error.message || "تعذر تحديث حالة أمر الصيانة."),
  });
  const createPlan = trpc.powerhub.maintenance.createPreventivePlan.useMutation({
    onSuccess: async () => { toast.success("تم إنشاء خطة الصيانة الوقائية."); setPlanTitle(""); setPlanDescription(""); setIntervalDays("30"); setIntervalHours(""); setNextDueHours(""); setNextDueDate(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)); await utils.powerhub.maintenance.listPreventivePlans.invalidate(); },
    onError: (error) => toast.error(error.message || "تعذر إنشاء خطة الصيانة الوقائية."),
  });
  const addPart = trpc.powerhub.maintenance.addPart.useMutation({
    onSuccess: async () => { toast.success("تم صرف الصنف وربط حركته بأمر الصيانة."); setPartQuantity("1"); setPartNotes(""); await Promise.all([utils.powerhub.maintenance.listParts.invalidate(), utils.powerhub.maintenance.listWorkOrders.invalidate(), utils.powerhub.inventory.stockOverview.invalidate(), utils.powerhub.inventory.listStockMovements.invalidate()]); },
    onError: (error) => toast.error(error.message || "تعذر صرف الصنف؛ تحقق من الرصيد والمخزن والصلاحيات."),
  });
  const evaluateDue = trpc.powerhub.maintenance.evaluateDuePlans.useMutation({
    onSuccess: async () => { await utils.powerhub.maintenance.listPreventivePlans.invalidate(); toast.success("تم تحديث استحقاقات الصيانة الوقائية."); },
    onError: (error) => toast.error(error.message || "تعذر تحديث استحقاقات الصيانة الوقائية."),
  });

  useEffect(() => {
    if (siteId > 0 && isAuthenticated && canManageMaintenance && evaluatedSiteRef.current !== siteId) {
      evaluatedSiteRef.current = siteId;
      evaluateDue.mutate({ siteId });
    }
  }, [siteId, isAuthenticated, canManageMaintenance]);

  useEffect(() => {
    if (!selectedPartsOrderId && orders.data?.length) {
      const next = orders.data.find((order) => openStatuses.includes(order.status));
      if (next) setSelectedPartsOrderId(String(next.work_order_id));
    }
  }, [orders.data, selectedPartsOrderId]);

  const submit = () => {
    const generator = Number(generatorId);
    if (!Number.isSafeInteger(generator) || generator <= 0) { toast.error("اختر مولدًا صحيحًا."); return; }
    if (title.trim().length < 3) { toast.error("اكتب وصفًا مختصرًا واضحًا للعطل أو العمل."); return; }
    if (orderType === "preventive" && !preventivePlanId) { toast.error("اختر خطة الصيانة الوقائية المرتبطة بالأمر."); return; }
    create.mutate({ siteId, generatorId: generator, orderType, priority, title: title.trim(), description: description.trim() || undefined, preventivePlanId: orderType === "preventive" ? Number(preventivePlanId) : undefined, operationKey: operationKey("maint-create") });
  };
  const submitPlan = () => {
    const generator = Number(planGeneratorId), days = intervalDays.trim() ? Number(intervalDays) : undefined, hours = intervalHours.trim() ? Number(intervalHours) : undefined, dueHours = nextDueHours.trim() ? Number(nextDueHours) : undefined;
    if (!Number.isSafeInteger(generator) || generator <= 0) { toast.error("اختر مولدًا لخطة الصيانة."); return; }
    if (planTitle.trim().length < 3) { toast.error("اكتب اسمًا واضحًا لخطة الصيانة."); return; }
    if ((!days || days <= 0) && (!hours || hours <= 0)) { toast.error("حدد فترة بالأيام أو بساعات التشغيل على الأقل."); return; }
    if (days && (!nextDueDate || !Number.isFinite(new Date(nextDueDate + "T12:00:00").getTime()))) { toast.error("حدد تاريخ الاستحقاق القادم."); return; }
    if (hours && (dueHours === undefined || !Number.isFinite(dueHours) || dueHours < 0)) { toast.error("حدد ساعات التشغيل عند الاستحقاق القادم."); return; }
    createPlan.mutate({ siteId, generatorId: generator, planCode: "PM-" + generator + "-" + crypto.randomUUID().slice(0, 8).toUpperCase(), title: planTitle.trim(), description: planDescription.trim() || undefined, intervalDays: days && days > 0 ? days : undefined, intervalOperatingHours: hours && hours > 0 ? hours : undefined, nextDueAt: days && days > 0 ? new Date(nextDueDate + "T12:00:00").toISOString() : undefined, nextDueOperatingHours: hours && hours > 0 ? dueHours : undefined, dueSoonDays: 7, dueSoonHours: 10, operationKey: operationKey("maint-plan") });
  };
  const submitPart = () => {
    const workOrder = Number(selectedPartsOrderId), item = Number(partItemId), warehouse = Number(partWarehouseId), quantity = Number(partQuantity);
    if (!Number.isSafeInteger(workOrder) || workOrder <= 0 || !selectedPartsOrder || !openStatuses.includes(selectedPartsOrder.status)) { toast.error("اختر أمر صيانة مفتوحًا لصرف القطع."); return; }
    if (!Number.isSafeInteger(item) || item <= 0 || !Number.isSafeInteger(warehouse) || warehouse <= 0) { toast.error("اختر الصنف والمخزن."); return; }
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000 || Math.round(quantity * 1000) !== quantity * 1000) { toast.error("أدخل كمية موجبة حتى ثلاث منازل عشرية."); return; }
    addPart.mutate({ siteId, workOrderId: workOrder, itemId: item, warehouseId: warehouse, quantity, notes: partNotes.trim() || undefined, operationKey: operationKey("maint-part") });
  };
  const doTransition = (order: NonNullable<typeof orders.data>[number], action: "start" | "wait_for_parts" | "complete" | "cancel") => {
    const requestKey = operationKey("maint-" + action + "-" + order.work_order_id);
    if (action === "complete") {
      const summary = window.prompt("اكتب ملخص الأعمال المنفذة (مطلوب):")?.trim();
      if (!summary) { toast.error("يلزم ملخص الإغلاق."); return; }
      const plan = plans.data?.find((candidate) => candidate.plan_id === order.preventive_plan_id);
      const needsHours = Number(plan?.interval_operating_hours ?? 0) > 0;
      const hours = needsHours ? window.prompt("أدخل ساعات التشغيل عند الإغلاق (مطلوب لهذه الخطة):")?.trim() : window.prompt("ساعات التشغيل عند الإغلاق (اختياري):")?.trim();
      if (needsHours && !hours) { toast.error("تتطلب الخطة قراءة ساعات التشغيل عند الإغلاق."); return; }
      const meterHoursClose = hours ? Number(hours) : undefined;
      if (hours && (!Number.isFinite(meterHoursClose) || Number(meterHoursClose) < 0 || Math.round(Number(meterHoursClose) * 100) !== Number(meterHoursClose) * 100)) { toast.error("قراءة ساعات التشغيل غير صحيحة أو تتجاوز منزلتين عشريتين."); return; }
      let laborCost = 0, externalServiceCost = 0;
      if (canManageExpenses) {
        const labor = window.prompt("تكلفة العمل (يمكن تركها 0):", "0"); if (labor === null) return;
        const service = window.prompt("تكلفة الخدمات الخارجية (يمكن تركها 0):", "0"); if (service === null) return;
        laborCost = Number(labor || 0); externalServiceCost = Number(service || 0);
        if (![laborCost, externalServiceCost].every((value) => Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 && Math.round(value * 100) === value * 100)) { toast.error("التكاليف يجب أن تكون بصفر أو موجبة وبحد أقصى منزلتين عشريتين."); return; }
      }
      const downtime = window.prompt("مدة التوقف بالدقائق (اختياري):")?.trim(), downtimeMinutes = downtime ? Number(downtime) : undefined;
      if (downtime && (!Number.isSafeInteger(downtimeMinutes) || Number(downtimeMinutes) < 0 || Number(downtimeMinutes) > 525600)) { toast.error("مدة التوقف يجب أن تكون عدد دقائق صحيحًا."); return; }
      transition.mutate({ siteId, workOrderId: order.work_order_id, action, workSummary: summary, meterHoursClose, downtimeMinutes, laborCost, externalServiceCost, operationKey: requestKey });
    } else if (action === "cancel") {
      const reason = window.prompt("سبب الإلغاء (مطلوب):")?.trim(); if (!reason || reason.length < 3) { toast.error("أدخل سببًا واضحًا للإلغاء."); return; }
      transition.mutate({ siteId, workOrderId: order.work_order_id, action, reason, operationKey: requestKey });
    } else transition.mutate({ siteId, workOrderId: order.work_order_id, action, operationKey: requestKey });
  };

  if (!canManageMaintenance) return <Card><CardContent className="p-6 text-sm text-muted-foreground">لا تملك صلاحية عرض أوامر الصيانة لهذا الفرع.</CardContent></Card>;
  const itemsForMaintenance = (items.data ?? []).filter((item) => ["spare_part", "oil", "filter", "maintenance_supply", "other"].includes(item.category));
  const openOrders = (orders.data ?? []).filter((order) => openStatuses.includes(order.status));
  const reportRows = maintenanceReport.data ?? [];
  const reportTotals = reportRows.reduce((sum, row) => ({
    workOrders: sum.workOrders + Number(row.work_order_count ?? 0),
    breakdowns: sum.breakdowns + Number(row.breakdown_count ?? 0),
    downtime: sum.downtime + Number(row.downtime_minutes ?? 0),
    cost: sum.cost + Number(row.total_cost_amount ?? 0),
  }), { workOrders: 0, breakdowns: 0, downtime: 0, cost: 0 });
  const exportMaintenanceReport = () => {
    if (maintenanceReport.isError || maintenanceReport.isLoading) { toast.error("حمّل تقرير الصيانة بنجاح قبل التصدير."); return; }
    const rows = [["المولد","العطل / العمل","عدد الأوامر","الأعطال","الصيانة الوقائية","المكتملة","المفتوحة","التوقف بالدقائق","تكلفة القطع","تكلفة العمل","الخدمات الخارجية","إجمالي التكلفة","أول بلاغ","آخر بلاغ"], ...reportRows.map((r) => [r.generator_name,r.fault_title,r.work_order_count,r.breakdown_count,r.preventive_count,r.completed_count,r.open_count,r.downtime_minutes,r.parts_cost,r.labor_cost,r.external_service_cost,r.total_cost_amount,r.first_reported_at,r.last_reported_at])];
    const blob = new Blob([String.fromCharCode(0xfeff) + rows.map((row) => row.map(csvCell).join(",")).join(String.fromCharCode(13, 10))], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href=url; anchor.download=`powerhub-maintenance-report-${siteId}-${reportFromDate}-${reportToDate}.csv`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success(`تم تصدير ${reportRows.length.toLocaleString("ar-PS")} مجموعة من تقرير الصيانة.`);
  };

  return <div className="space-y-4" dir="rtl">
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Wrench className="h-5 w-5" /> تسجيل عطل أو أمر صيانة</CardTitle></CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm"><span>المولد</span><select className="h-10 w-full rounded-md border bg-background px-3" value={generatorId} onChange={(e) => { setGeneratorId(e.target.value); setPreventivePlanId(""); }}><option value="">اختر المولد</option>{(generators.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} — {g.code}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>نوع الأمر</span><select className="h-10 w-full rounded-md border bg-background px-3" value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)}>{Object.entries(orderTypeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {orderType === "preventive" ? <label className="space-y-1 text-sm"><span>الخطة الوقائية</span><select className="h-10 w-full rounded-md border bg-background px-3" value={preventivePlanId} onChange={(e) => setPreventivePlanId(e.target.value)}><option value="">اختر خطة للمولد</option>{(plans.data ?? []).filter((p) => p.generator_id === Number(generatorId) && p.is_active).map((p) => <option key={p.plan_id} value={p.plan_id}>{p.plan_code} — {p.title}</option>)}</select></label> : null}
        <label className="space-y-1 text-sm"><span>الأولوية</span><select className="h-10 w-full rounded-md border bg-background px-3" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>{Object.entries(priorityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="space-y-1 text-sm md:col-span-2"><span>عنوان العطل / العمل</span><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={180} placeholder="مثال: ارتفاع حرارة المحرك أو صيانة زيت دورية" /></label>
        <label className="space-y-1 text-sm md:col-span-2"><span>تفاصيل البلاغ</span><textarea className="min-h-20 w-full rounded-md border bg-background p-3" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} /></label>
        <div className="md:col-span-2"><Button onClick={submit} disabled={create.isPending || !generators.data?.length}>{create.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Wrench className="ml-2 h-4 w-4" />} إنشاء أمر الصيانة</Button></div>
      </CardContent>
    </Card>

    <Card><CardHeader><CardTitle className="flex items-center gap-2"><CalendarClock className="h-5 w-5" /> خطط الصيانة الوقائية والاستحقاقات</CardTitle></CardHeader>
      <CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm"><span>المولد</span><select className="h-10 w-full rounded-md border bg-background px-3" value={planGeneratorId} onChange={(e) => setPlanGeneratorId(e.target.value)}><option value="">اختر المولد للخطة</option>{(generators.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} — {g.code}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>اسم الخطة</span><Input value={planTitle} onChange={(e) => setPlanTitle(e.target.value)} maxLength={180} placeholder="تغيير الزيت والفلاتر" /></label>
        <label className="space-y-1 text-sm"><span>الفترة بالأيام</span><Input type="number" min="1" max="3650" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} /></label>
        <label className="space-y-1 text-sm"><span>الفترة بساعات التشغيل (اختياري)</span><Input type="number" min="0.01" max="1000000" step="0.01" value={intervalHours} onChange={(e) => setIntervalHours(e.target.value)} /></label>
        {intervalDays.trim() ? <label className="space-y-1 text-sm"><span>تاريخ الاستحقاق القادم</span><Input type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} /></label> : null}
        {intervalHours.trim() ? <label className="space-y-1 text-sm"><span>ساعات التشغيل عند الاستحقاق القادم</span><Input type="number" min="0" step="0.01" value={nextDueHours} onChange={(e) => setNextDueHours(e.target.value)} /></label> : null}
        <label className="space-y-1 text-sm md:col-span-2"><span>تفاصيل الخطة</span><textarea className="min-h-16 w-full rounded-md border bg-background p-3" value={planDescription} onChange={(e) => setPlanDescription(e.target.value)} maxLength={5000} /></label>
        <div className="md:col-span-2"><Button onClick={submitPlan} disabled={createPlan.isPending || !generators.data?.length}>{createPlan.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CalendarClock className="ml-2 h-4 w-4" />} حفظ الخطة</Button> <Button variant="outline" className="mr-2" onClick={() => evaluateDue.mutate({ siteId })} disabled={evaluateDue.isPending}><RefreshCw className="ml-2 h-4 w-4" /> تحديث الاستحقاقات</Button></div>
      </div>
      <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[760px] text-right text-sm"><thead className="bg-muted/60"><tr>{["المولد","الخطة","الفترة","تاريخ الاستحقاق","ساعات التشغيل","الحالة"].map((s) => <th key={s} className="p-3">{s}</th>)}</tr></thead><tbody>{(plans.data ?? []).map((p) => <tr key={p.plan_id} className="border-t"><td className="p-3">{p.generator_name}</td><td className="p-3">{p.title}<div className="text-xs text-muted-foreground">{p.plan_code}</div></td><td className="p-3">{[p.interval_days ? String(p.interval_days) + " يوم" : null, p.interval_operating_hours ? String(p.interval_operating_hours) + " ساعة تشغيل" : null].filter(Boolean).join(" / ") || "—"}</td><td className="p-3">{p.next_due_at ? new Date(p.next_due_at).toLocaleDateString("ar-PS") : "—"}</td><td className="p-3">{p.next_due_operating_hours ?? "—"}</td><td className="p-3">{p.alert_type ? <span className={p.alert_type === "overdue" ? "text-destructive font-medium" : "text-amber-700"}>{alertLabels[p.alert_type] ?? p.alert_type}</span> : "ضمن الموعد"}</td></tr>)}</tbody></table></div>
      </CardContent>
    </Card>

    {canIssueInventory ? <Card><CardHeader><CardTitle className="flex items-center gap-2"><PackagePlus className="h-5 w-5" /> صرف قطع الغيار والزيوت والفلاتر</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1 text-sm"><span>أمر الصيانة المفتوح</span><select className="h-10 w-full rounded-md border bg-background px-3" value={selectedPartsOrderId} onChange={(e) => setSelectedPartsOrderId(e.target.value)}><option value="">اختر الأمر</option>{openOrders.map((o) => <option key={o.work_order_id} value={o.work_order_id}>{o.work_order_number} — {o.generator_name} — {o.title}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>الصنف</span><select className="h-10 w-full rounded-md border bg-background px-3" value={partItemId} onChange={(e) => setPartItemId(e.target.value)}><option value="">اختر صنفًا</option>{itemsForMaintenance.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.base_unit}) — {i.sku || i.category}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>المخزن</span><select className="h-10 w-full rounded-md border bg-background px-3" value={partWarehouseId} onChange={(e) => setPartWarehouseId(e.target.value)}><option value="">اختر المخزن</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name} — {w.code}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>الكمية</span><Input type="number" min="0.001" step="0.001" value={partQuantity} onChange={(e) => setPartQuantity(e.target.value)} /></label>
        <label className="space-y-1 text-sm md:col-span-2 xl:col-span-3"><span>ملاحظات الصرف</span><Input value={partNotes} onChange={(e) => setPartNotes(e.target.value)} maxLength={1000} /></label>
        <div className="flex items-end"><Button onClick={submitPart} disabled={addPart.isPending || !selectedPartsOrder || !openStatuses.includes(selectedPartsOrder.status) || !itemsForMaintenance.length || !(warehouses.data?.length)}>{addPart.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <PackagePlus className="ml-2 h-4 w-4" />} صرف وربط بالمخزون</Button></div>
      </div>
      {parts.isLoading ? <p className="text-sm text-muted-foreground">جارٍ تحميل تفاصيل الصرف…</p> : parts.error ? <p className="text-sm text-destructive">تعذر تحميل سجل الصرف لهذا الأمر.</p> : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[650px] text-right text-sm"><thead className="bg-muted/60"><tr>{["الصنف","المخزن","الكمية","تكلفة الوحدة","الإجمالي","وقت الصرف"].map((s) => <th key={s} className="p-3">{s}</th>)}</tr></thead><tbody>{(parts.data ?? []).map((p) => <tr key={p.part_id} className="border-t"><td className="p-3">{p.item_name}</td><td className="p-3">{p.warehouse_name}</td><td className="p-3">{p.quantity}</td><td className="p-3">{money(p.unit_cost)}</td><td className="p-3">{money(p.total_cost_amount)}</td><td className="p-3">{new Date(p.issued_at).toLocaleString("ar-PS")}</td></tr>)}{!parts.data?.length ? <tr><td className="p-4 text-center text-muted-foreground" colSpan={6}>لا توجد قطع مصروفة لهذا الأمر.</td></tr> : null}</tbody></table></div>}
    </CardContent></Card> : null}

    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><CardTitle>تقرير الصيانة والأعطال حسب المولد</CardTitle><p className="mt-1 text-sm text-muted-foreground">الأعطال المتكررة وأوامر الصيانة ومدة التوقف وتكاليف القطع والعمل والخدمات للفترة المختارة.</p></div>
          <Button type="button" variant="outline" onClick={exportMaintenanceReport} disabled={maintenanceReport.isLoading || maintenanceReport.isFetching || maintenanceReport.isError}><Download className="ml-2 h-4 w-4" /> تصدير CSV</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-4">
          <label className="space-y-1 text-sm"><span>من تاريخ البلاغ</span><Input type="date" value={reportFromDate} max={reportToDate || undefined} onChange={(e) => setReportFromDate(e.target.value)} /></label>
          <label className="space-y-1 text-sm"><span>إلى تاريخ البلاغ</span><Input type="date" value={reportToDate} min={reportFromDate || undefined} onChange={(e) => setReportToDate(e.target.value)} /></label>
          <label className="space-y-1 text-sm"><span>المولد</span><select className="h-10 w-full rounded-md border bg-background px-3" value={reportGeneratorId} onChange={(e) => setReportGeneratorId(e.target.value)}><option value="">كل المولدات</option>{(generators.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} — {g.code}</option>)}</select></label>
          <div className="flex items-end"><Button type="button" variant="outline" onClick={() => void maintenanceReport.refetch()} disabled={maintenanceReport.isFetching || !reportFromDate || !reportToDate || reportFromDate > reportToDate}><RefreshCw className="ml-2 h-4 w-4" /> تحديث التقرير</Button></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-md border p-3"><p className="text-sm text-muted-foreground">أوامر الصيانة</p><p className="text-2xl font-semibold">{maintenanceReport.isLoading || maintenanceReport.isError ? "—" : reportTotals.workOrders.toLocaleString("ar-PS")}</p></div>
          <div className="rounded-md border p-3"><p className="text-sm text-muted-foreground">بلاغات الأعطال</p><p className="text-2xl font-semibold">{maintenanceReport.isLoading || maintenanceReport.isError ? "—" : reportTotals.breakdowns.toLocaleString("ar-PS")}</p></div>
          <div className="rounded-md border p-3"><p className="text-sm text-muted-foreground">التوقف المسجل</p><p className="text-2xl font-semibold">{maintenanceReport.isLoading || maintenanceReport.isError ? "—" : reportTotals.downtime.toLocaleString("ar-PS") + " دقيقة"}</p></div>
          <div className="rounded-md border p-3"><p className="text-sm text-muted-foreground">إجمالي التكلفة</p><p className="text-2xl font-semibold">{maintenanceReport.isLoading || maintenanceReport.isError ? "—" : money(reportTotals.cost)}</p></div>
        </div>
        {maintenanceReport.isLoading ? <p className="py-6 text-center text-muted-foreground">جارٍ تجميع تقرير الصيانة…</p>
          : maintenanceReport.error ? <p role="alert" className="py-6 text-center text-destructive">تعذر تحميل التقرير. اختر نطاقًا لا يتجاوز 366 يومًا ثم أعد المحاولة.</p>
          : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[1120px] text-right text-sm"><thead className="bg-muted/60"><tr>{["المولد","العطل / العمل المتكرر","الأوامر","الأعطال","الوقائية","المكتملة","المفتوحة","التوقف (دقيقة)","القطع","العمل","الخدمات","الإجمالي"].map((s) => <th key={s} className="p-3">{s}</th>)}</tr></thead><tbody>{reportRows.map((r) => <tr key={r.generator_id + ":" + r.fault_title} className="border-t"><td className="p-3">{r.generator_name} <span className="text-xs text-muted-foreground">#{r.generator_id}</span></td><td className="p-3">{r.fault_title}</td><td className="p-3">{r.work_order_count}</td><td className="p-3">{r.breakdown_count}</td><td className="p-3">{r.preventive_count}</td><td className="p-3">{r.completed_count}</td><td className="p-3">{r.open_count}</td><td className="p-3">{r.downtime_minutes}</td><td className="p-3 whitespace-nowrap">{money(r.parts_cost)}</td><td className="p-3 whitespace-nowrap">{money(r.labor_cost)}</td><td className="p-3 whitespace-nowrap">{money(r.external_service_cost)}</td><td className="p-3 whitespace-nowrap font-semibold">{money(r.total_cost_amount)}</td></tr>)}{!reportRows.length ? <tr><td colSpan={12} className="p-5 text-center text-muted-foreground">لا توجد أوامر صيانة في الفترة المحددة.</td></tr> : null}</tbody></table></div>}
      </CardContent>
    </Card>

    <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle className="flex items-center gap-2"><ClipboardList className="h-5 w-5" /> أوامر الصيانة وسجل الأعطال</CardTitle><div className="flex gap-2"><select aria-label="تصفية المولد" className="h-9 rounded-md border bg-background px-2 text-sm" value={orderGeneratorFilter} onChange={(e) => setOrderGeneratorFilter(e.target.value)}><option value="">كل المولدات</option>{(generators.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select><select aria-label="تصفية حالة أمر الصيانة" className="h-9 rounded-md border bg-background px-2 text-sm" value={filter} onChange={(e) => setFilter(e.target.value as OrderStatus | "")}><option value="">كل الحالات</option>{Object.entries(statusLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select><Button variant="outline" size="icon" onClick={() => orders.refetch()} aria-label="تحديث القائمة"><RefreshCw className="h-4 w-4" /></Button></div></div></CardHeader><CardContent>
      {orders.isLoading ? <p className="py-8 text-center text-muted-foreground">جارٍ تحميل أوامر الصيانة…</p> : orders.error ? <p className="py-8 text-center text-destructive">تعذر تحميل السجل. تحقق من الصلاحيات ومخطط قاعدة البيانات.</p> : !orders.data?.length ? <p className="py-8 text-center text-muted-foreground">لا توجد أوامر صيانة في هذا العرض.</p> :
      <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[940px] text-right text-sm"><thead className="bg-muted/60"><tr>{["رقم الأمر","المولد","العطل / العمل","النوع","الأولوية","الحالة","تاريخ البلاغ","تكلفة القطع","التكلفة الإجمالية","الإجراءات"].map((s) => <th key={s} className="p-3">{s}</th>)}</tr></thead><tbody>{orders.data.map((o) => <tr key={o.work_order_id} className="border-t"><td className="p-3 font-mono">{o.work_order_number}</td><td className="p-3">{o.generator_name} <span className="text-muted-foreground">#{o.generator_id}</span></td><td className="max-w-64 p-3"><div className="font-medium">{o.title}</div><div className="line-clamp-2 text-xs text-muted-foreground">{o.description || "—"}</div></td><td className="p-3">{orderTypeLabels[o.order_type] ?? o.order_type}{o.preventive_plan_id ? <div className="text-xs text-muted-foreground">خطة #{o.preventive_plan_id}</div> : null}</td><td className="p-3">{priorityLabels[o.priority] ?? o.priority}</td><td className="p-3">{statusLabels[o.status] ?? o.status}</td><td className="p-3 whitespace-nowrap">{new Date(o.reported_at).toLocaleString("ar-PS")}</td><td className="p-3 whitespace-nowrap">{money(o.parts_cost)}</td><td className="p-3 whitespace-nowrap font-medium">{money(o.total_cost_amount)}</td><td className="p-3"><div className="flex gap-1">{["new","scheduled","waiting_for_parts"].includes(o.status) ? <Button size="sm" variant="outline" disabled={transition.isPending} onClick={() => doTransition(o,"start")}>بدء</Button> : null}{o.status==="in_progress" ? <><Button size="sm" variant="outline" disabled={transition.isPending} onClick={() => doTransition(o,"wait_for_parts")}>انتظار قطع</Button><Button size="sm" disabled={transition.isPending} onClick={() => doTransition(o,"complete")}>إغلاق</Button></> : null}{openStatuses.includes(o.status) ? <Button size="sm" variant="ghost" disabled={transition.isPending} onClick={() => doTransition(o,"cancel")}>إلغاء</Button> : null}</div></td></tr>)}</tbody></table></div>}
    </CardContent></Card>
  </div>;
}
