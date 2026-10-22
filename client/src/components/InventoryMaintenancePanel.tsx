import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { ClipboardList, Loader2, RefreshCw, Wrench } from "lucide-react";

const statusLabels: Record<string, string> = {
  scheduled: "مجدول", new: "جديد", in_progress: "قيد التنفيذ",
  waiting_for_parts: "بانتظار قطع الغيار", completed: "مكتمل", cancelled: "ملغي",
};
const priorityLabels: Record<string, string> = { low: "منخفضة", normal: "عادية", high: "مرتفعة", urgent: "عاجلة" };
const money = (value: unknown) => new Intl.NumberFormat("ar-PS", {
  style: "currency", currency: "ILS", minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(Number(value ?? 0));

export default function InventoryMaintenancePanel({
  siteId, isAuthenticated, canManageMaintenance,
}: { siteId: number; isAuthenticated: boolean; canManageMaintenance: boolean }) {
  const utils = trpc.useUtils();
  const [generatorId, setGeneratorId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"low" | "normal" | "high" | "urgent">("normal");
  const [filter, setFilter] = useState("");
  const orders = trpc.powerhub.maintenance.listWorkOrders.useQuery(
    { siteId, status: filter ? filter as "scheduled" | "new" | "in_progress" | "waiting_for_parts" | "completed" | "cancelled" : undefined, limit: 100 },
    { enabled: Boolean(siteId && isAuthenticated && canManageMaintenance), staleTime: 15_000 },
  );
  const create = trpc.powerhub.maintenance.createWorkOrder.useMutation({
    onSuccess: async () => {
      toast.success("تم إنشاء أمر الصيانة.");
      setTitle(""); setDescription(""); setGeneratorId(""); setPriority("normal");
      await utils.powerhub.maintenance.listWorkOrders.invalidate();
    },
    onError: (error) => toast.error(error.message || "تعذر إنشاء أمر الصيانة."),
  });
  const transition = trpc.powerhub.maintenance.transitionWorkOrder.useMutation({
    onSuccess: async () => {
      toast.success("تم تحديث حالة أمر الصيانة.");
      await utils.powerhub.maintenance.listWorkOrders.invalidate();
      await utils.powerhub.maintenance.listPreventivePlans.invalidate();
    },
    onError: (error) => toast.error(error.message || "تعذر تحديث أمر الصيانة."),
  });
  const submit = () => {
    const generator = Number(generatorId);
    if (!Number.isSafeInteger(generator) || generator <= 0) { toast.error("أدخل رقم مولد صحيحًا."); return; }
    if (title.trim().length < 3) { toast.error("اكتب وصفًا مختصرًا واضحًا للعطل أو العمل."); return; }
    create.mutate({
      siteId, generatorId: generator, orderType: "breakdown", priority,
      title: title.trim(), description: description.trim() || undefined,
      operationKey: "maint-create-" + crypto.randomUUID(),
    });
  };
  const doTransition = (workOrderId: number, action: "start" | "wait_for_parts" | "complete" | "cancel") => {
    const operationKey = "maint-" + action + "-" + workOrderId + "-" + crypto.randomUUID();
    if (action === "complete") {
      const summary = window.prompt("اكتب ملخص الأعمال المنفذة (مطلوب):")?.trim();
      if (!summary) { toast.error("يلزم ملخص الإغلاق."); return; }
      const hours = window.prompt("ساعات التشغيل عند الإغلاق (اتركها فارغة إذا لم تكن مطلوبة):")?.trim();
      const meterHoursClose = hours ? Number(hours) : undefined;
      if (hours && (!Number.isFinite(meterHoursClose) || Number(meterHoursClose) < 0)) { toast.error("قراءة ساعات التشغيل غير صحيحة."); return; }
      transition.mutate({ siteId, workOrderId, action, workSummary: summary, meterHoursClose, operationKey });
    } else if (action === "cancel") {
      const reason = window.prompt("سبب الإلغاء (مطلوب):")?.trim();
      if (!reason || reason.length < 3) { toast.error("أدخل سببًا واضحًا للإلغاء."); return; }
      transition.mutate({ siteId, workOrderId, action, reason, operationKey });
    } else transition.mutate({ siteId, workOrderId, action, operationKey });
  };

  if (!canManageMaintenance) return <Card><CardContent className="p-6 text-sm text-muted-foreground">لا تملك صلاحية عرض أوامر الصيانة لهذا الفرع.</CardContent></Card>;

  return <div className="space-y-4" dir="rtl">
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Wrench className="h-5 w-5" /> تسجيل عطل أو أمر صيانة</CardTitle></CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm"><span>رقم المولد</span><Input inputMode="numeric" value={generatorId} onChange={(e) => setGeneratorId(e.target.value)} placeholder="رقم المولد داخل النظام" /></label>
        <label className="space-y-1 text-sm"><span>الأولوية</span><select className="h-10 w-full rounded-md border bg-background px-3" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}><option value="low">منخفضة</option><option value="normal">عادية</option><option value="high">مرتفعة</option><option value="urgent">عاجلة</option></select></label>
        <label className="space-y-1 text-sm md:col-span-2"><span>عنوان العطل / العمل</span><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={180} placeholder="مثال: ارتفاع حرارة المحرك" /></label>
        <label className="space-y-1 text-sm md:col-span-2"><span>تفاصيل البلاغ</span><textarea className="min-h-20 w-full rounded-md border bg-background p-3" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} placeholder="الأعراض، الظروف، الملاحظات الأولية..." /></label>
        <div className="md:col-span-2"><Button onClick={submit} disabled={create.isPending}>{create.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Wrench className="ml-2 h-4 w-4" />} إنشاء أمر الصيانة</Button></div>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle className="flex items-center gap-2"><ClipboardList className="h-5 w-5" /> أوامر الصيانة وسجل الأعطال</CardTitle><div className="flex gap-2"><select aria-label="تصفية حالة أمر الصيانة" className="h-9 rounded-md border bg-background px-2 text-sm" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">كل الحالات</option>{Object.entries(statusLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select><Button variant="outline" size="icon" onClick={() => orders.refetch()} aria-label="تحديث القائمة"><RefreshCw className="h-4 w-4" /></Button></div></div></CardHeader>
      <CardContent>
        {orders.isLoading ? <p className="py-8 text-center text-muted-foreground">جارٍ تحميل أوامر الصيانة…</p>
          : orders.error ? <p className="py-8 text-center text-destructive">تعذر تحميل السجل. تحقق من صلاحياتك ومخطط قاعدة البيانات.</p>
          : !orders.data?.length ? <p className="py-8 text-center text-muted-foreground">لا توجد أوامر صيانة في هذا العرض.</p>
          : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[850px] text-right text-sm"><thead className="bg-muted/60"><tr>{["رقم الأمر","المولد","العطل / العمل","الأولوية","الحالة","تاريخ البلاغ","تكلفة القطع","التكلفة الإجمالية","الإجراءات"].map((label) => <th key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{orders.data.map((order) => <tr key={order.work_order_id} className="border-t"><td className="p-3 font-mono">{order.work_order_number}</td><td className="p-3">{order.generator_name} <span className="text-muted-foreground">#{order.generator_id}</span></td><td className="max-w-64 p-3"><div className="font-medium">{order.title}</div><div className="line-clamp-2 text-xs text-muted-foreground">{order.description || "—"}</div></td><td className="p-3">{priorityLabels[order.priority] ?? order.priority}</td><td className="p-3">{statusLabels[order.status] ?? order.status}</td><td className="p-3 whitespace-nowrap">{new Date(order.reported_at).toLocaleString("ar-PS")}</td><td className="p-3 whitespace-nowrap">{money(order.parts_cost)}</td><td className="p-3 whitespace-nowrap font-medium">{money(order.total_cost_amount)}</td><td className="p-3"><div className="flex gap-1">{["new","scheduled","waiting_for_parts"].includes(order.status) ? <Button size="sm" variant="outline" disabled={transition.isPending} onClick={() => doTransition(order.work_order_id,"start")}>بدء</Button> : null}{order.status==="in_progress" ? <><Button size="sm" variant="outline" disabled={transition.isPending} onClick={() => doTransition(order.work_order_id,"wait_for_parts")}>انتظار قطع</Button><Button size="sm" disabled={transition.isPending} onClick={() => doTransition(order.work_order_id,"complete")}>إغلاق</Button></> : null}{["new","scheduled","in_progress","waiting_for_parts"].includes(order.status) ? <Button size="sm" variant="ghost" disabled={transition.isPending} onClick={() => doTransition(order.work_order_id,"cancel")}>إلغاء</Button> : null}</div></td></tr>)}</tbody></table></div>}
      </CardContent>
    </Card>
  </div>;
}
