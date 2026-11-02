import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/_core/hooks/useAuth";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { can, type PowerCapability } from "@shared/powerhub-rbac";
import { ArrowLeftRight, Search, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

export default function FieldReaderDistributionPage() {
  const [location, setLocation] = useLocation();
  const { user } = useAuth();
  const { isOnline, isChecking } = usePowerHubConnectivity();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: Boolean(user && user.role !== "admin" && isOnline && !isChecking), refetchOnReconnect: true });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId && user && user.role !== "admin" && isOnline && !isChecking), refetchOnReconnect: true });
  const isOwner = accessQuery.data?.role === "owner";
  const distributionQuery = trpc.powerhub.staff.readingDistribution.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId && isOwner && isOnline && !isChecking), refetchOnReconnect: true });
  const staffQuery = trpc.powerhub.staff.list.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId && isOwner && isOnline && !isChecking), refetchOnReconnect: true });
  const quotaQuery = trpc.powerhub.staff.allowedSubaccountRoles.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId && isOwner && isOnline && !isChecking), refetchOnReconnect: true });
  const selectedReaderIds = distributionQuery.data?.readerUserIds ?? [];
  const eligibleReaders = useMemo(() => {
    const now = Date.now();
    const unique = new Map<number, { id: number; name: string | null; email: string | null }>();
    for (const row of staffQuery.data ?? []) {
      const permissions = row.profile.permissions as PowerCapability[] | null;
      const start = row.profile.suspensionStartedAt ? new Date(row.profile.suspensionStartedAt).getTime() : null;
      const end = row.profile.suspensionEndsAt ? new Date(row.profile.suspensionEndsAt).getTime() : null;
      const suspended = start !== null && start <= now && (end === null || end > now);
      if (row.profile.role !== "technician" || !row.profile.isActive || row.profile.archivedAt || row.user.accountStatus !== "active" || suspended) continue;
      if (!can("technician", "recordReadings", permissions) || !can("technician", "accessFieldApp", permissions)) continue;
      unique.set(row.user.id, row.user);
    }
    return Array.from(unique.values()).filter((reader) => selectedReaderIds.includes(reader.id));
  }, [staffQuery.data, selectedReaderIds.join(",")]);
  const quotaLimit = Number(quotaQuery.data?.fieldUserLimit ?? 0);
  const configurationWithinQuota = selectedReaderIds.length >= 2 && selectedReaderIds.length <= quotaLimit && eligibleReaders.length === selectedReaderIds.length;
  const tab = location.includes("view=all") ? "all" : "unassigned";
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [targets, setTargets] = useState<Record<number, number>>({});
  const pageSize = 50;
  const assignmentsQuery = trpc.powerhub.staff.fieldReaderAssignments.useQuery({
    siteId: siteId ?? 0, search: search.trim() || undefined, onlyUnassigned: tab === "unassigned", limit: pageSize, offset,
  }, { enabled: Boolean(siteId && isOwner && distributionQuery.data?.isEnabled && isOnline && !isChecking), refetchOnReconnect: true });
  const moveMutation = trpc.powerhub.staff.moveFieldReaderSubscriber.useMutation({
    onSuccess: async () => {
      await Promise.all([assignmentsQuery.refetch(), distributionQuery.refetch()]);
      setTargets({});
      toast.success("تم نقل المشترك إلى مدخل القراءة المحدد.");
    },
    onError: (error) => toast.error(error.message),
  });
  const items = assignmentsQuery.data?.items ?? [];
  const totalCount = assignmentsQuery.data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const updateTab = (next: "unassigned" | "all") => {
    setOffset(0);
    setTargets({});
    setLocation(next === "unassigned" ? "/field-distribution?view=unassigned" : "/field-distribution?view=all");
  };
  const selectedSite = sitesQuery.data?.find((site) => site.id === siteId);

  return <DashboardLayout><main className="space-y-6 pb-12" dir="rtl">
    <header className="rounded-[26px] border border-sky-400/20 bg-[#111823] p-6 shadow-panel sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><div className="flex items-center gap-2 text-sm font-bold text-sky-300"><UsersRound className="h-4 w-4" />الميدان والرقابة</div>
          <h1 className="mt-2 text-2xl font-extrabold text-white">توزيع المشتركين على مدخلي القراءة</h1>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-400">تابع المشتركين الجدد والقدامى الذين لا يملكون مدخل قراءة صالحًا، وانقل أي مشترك إلى مدخل آخر دون حذف قراءاته أو تغيير بياناته المالية.</p></div>
        <div className="flex items-center gap-2">
          {sitesQuery.data?.length ? <select aria-label="اختيار الفرع لتوزيع القراءات" value={String(siteId ?? "")} onChange={(event) => { setSiteId(Number(event.target.value)); setOffset(0); }} className="h-10 max-w-56 rounded-xl border border-white/10 bg-[#0D1117]/80 px-3 text-sm font-bold text-slate-200">{sitesQuery.data.map((site) => <option key={site.id} value={site.id} className="bg-[#111823]">{site.name}</option>)}</select> : null}
          <Badge className="bg-sky-400/10 text-sky-200">{selectedSite?.name ?? "اختر الفرع"}</Badge>
        </div>
      </div>
    </header>
    {!isOnline ? <Card role="status" className="border-amber-400/25 bg-amber-400/[.04]"><CardContent className="p-4 text-sm text-amber-100">إدارة قوائم التخصيص والنقل تتطلب اتصالاً بالخادم؛ لم نستخدم نسخة محلية لهذه البيانات.</CardContent></Card> : null}
    {accessQuery.isLoading || sitesQuery.isLoading || isChecking ? <Card className="border-white/8 bg-[#111823]"><CardContent className="p-6 text-sm text-slate-400">جارٍ التحقق من صلاحية إدارة توزيع المشتركين...</CardContent></Card>
      : !isOwner ? <Card role="alert" className="border-rose-400/25 bg-[#111823]"><CardContent className="p-6"><h2 className="font-bold text-rose-100">هذه الصفحة متاحة لصاحب المولد فقط</h2><p className="mt-2 text-sm text-slate-400">نقل المشتركين وإدارة توزيعهم من صلاحيات مالك المولد، ولا تُعرض بيانات التخصيص للحسابات الأخرى.</p></CardContent></Card>
      : <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><p className="text-xs text-slate-500">حالة التقسيم</p><p className="mt-2 font-bold text-white">{distributionQuery.data?.isEnabled ? "مفعّل" : "متوقف"}</p></CardContent></Card>
          <Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><p className="text-xs text-slate-500">الحسابات المختارة</p><p className="mt-2 font-bold text-white">{selectedReaderIds.length}</p></CardContent></Card>
          <Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><p className="text-xs text-slate-500">حصة التطبيق الميداني</p><p className="mt-2 font-bold text-white">{quotaQuery.data?.fieldUserCount ?? "—"} / {quotaLimit}</p></CardContent></Card>
        </div>
        {!distributionQuery.data?.isEnabled ? <Card className="border-amber-400/25 bg-amber-400/[.04]"><CardContent className="p-5"><h2 className="font-bold text-amber-100">التقسيم متوقف حاليًا</h2><p className="mt-2 text-sm leading-7 text-slate-300">عند توقف التقسيم تكون جميع المشتركين النشطين متاحة لكل مدخل قراءة مؤهل في الفرع، ولا توجد قائمة غير مفرزة. فعّل التقسيم وحدد حسابين على الأقل من إعدادات الحسابات.</p><Button type="button" onClick={() => setLocation("/staff")} className="mt-4 bg-[#F5B800] font-bold text-[#0D1117]">فتح إعدادات الحسابات</Button></CardContent></Card>
          : <div className="space-y-4">
            {!configurationWithinQuota ? <Card role="alert" className="border-amber-400/25 bg-amber-400/[.04]"><CardContent className="p-4 text-sm leading-7 text-amber-100">إعداد التقسيم لا يطابق الحسابات الميدانية النشطة أو يتجاوز حصة الاشتراك. راجع إعداد التقسيم قبل النقل.</CardContent></Card> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant={tab === "unassigned" ? "default" : "outline"} onClick={() => updateTab("unassigned")} className={tab === "unassigned" ? "bg-[#F5B800] text-[#0D1117]" : "border-white/10 text-slate-200"}>المشتركون غير المفرزين <Badge className="mr-2 bg-black/10">{distributionQuery.data?.unassignedSubscriberCount ?? 0}</Badge></Button>
              <Button type="button" variant={tab === "all" ? "default" : "outline"} onClick={() => updateTab("all")} className={tab === "all" ? "bg-[#F5B800] text-[#0D1117]" : "border-white/10 text-slate-200"}>كل المشتركين</Button>
              <Button type="button" variant="outline" onClick={() => setLocation("/staff")} className="mr-auto border-white/10 text-slate-300">إعداد التقسيم</Button>
            </div>
            <Card className="border-white/8 bg-[#111823]"><CardContent className="p-4 sm:p-5">
              <label className="flex max-w-xl items-center gap-3 rounded-xl border border-white/10 bg-white/[.02] px-3"><Search className="h-4 w-4 text-slate-500" /><input value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} placeholder="ابحث بالاسم أو رقم المشترك أو الهاتف أو العنوان" aria-label="بحث قائمة توزيع المشتركين" className="h-11 min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-slate-500" /></label>
              <div className="mt-4 flex items-center justify-between gap-2"><h2 className="font-bold text-white">{tab === "unassigned" ? "المشتركون الذين يحتاجون إلى إسناد" : "نقل مشترك بين مدخلي القراءة"}</h2><Badge className="bg-sky-400/10 text-sky-200">{totalCount.toLocaleString("ar")} مشترك</Badge></div>
              {assignmentsQuery.isLoading ? <p role="status" className="py-10 text-center text-sm text-slate-400">جارٍ تحميل القائمة...</p>
                : items.length ? <div className="mt-4 space-y-3">{items.map((item) => <div key={item.subscriberId} className="grid gap-3 rounded-xl border border-white/8 bg-white/[.02] p-4 lg:grid-cols-[1fr_1.1fr_auto] lg:items-center">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-white">{item.fullName || "دون اسم"}</strong><Badge className="bg-white/5 text-slate-300">{item.subscriberNo}</Badge>{item.isUnassigned ? <Badge className="bg-amber-400/10 text-amber-200">غير مفرز</Badge> : <Badge className="bg-emerald-400/10 text-emerald-200">مفرز</Badge>}</div><p className="mt-1 text-xs text-slate-400">{item.address || "لا يوجد عنوان"} · {item.phone || "لا يوجد هاتف"}</p><p className="mt-1 text-[11px] text-slate-500">تاريخ الإضافة: {item.createdAt ? new Date(item.createdAt).toLocaleDateString("ar") : "غير محدد"}</p></div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center"><div className="text-xs text-slate-400">المدخل الحالي: <strong className="text-slate-200">{item.isUnassigned ? "غير مفرز / حساب غير صالح" : item.assignedReaderName || item.assignedReaderEmail || \`حساب #\${item.assignedReaderUserId}\`}</strong></div><select aria-label={\`مدخل القراءة للمشترك \${item.subscriberNo}\`} value={String(targets[item.subscriberId] ?? "")} onChange={(event) => setTargets((current) => ({ ...current, [item.subscriberId]: Number(event.target.value) }))} className="h-10 min-w-0 rounded-lg border border-white/10 bg-[#0D1117] px-3 text-sm text-white"><option value="">اختر مدخل القراءة الجديد</option>{eligibleReaders.map((reader) => <option key={reader.id} value={reader.id} disabled={reader.id === item.assignedReaderUserId}>{reader.name || reader.email || \`مدخل قراءة #\${reader.id}\`}</option>)}</select></div>
                  <Button type="button" disabled={!configurationWithinQuota || !targets[item.subscriberId] || targets[item.subscriberId] === item.assignedReaderUserId || moveMutation.isPending || !isOnline} onClick={() => moveMutation.mutate({ siteId: siteId!, subscriberId: item.subscriberId, targetReaderUserId: targets[item.subscriberId] })} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><ArrowLeftRight className="ml-2 h-4 w-4" />{item.isUnassigned ? "إسناد" : "نقل المشترك"}</Button>
                </div>)}</div>
                  : <p className="py-12 text-center text-sm text-slate-400">{tab === "unassigned" ? "لا يوجد مشتركون غير مفرزين في هذا الفرع حاليًا." : "لا توجد نتائج مطابقة للبحث."}</p>}
              {totalCount > pageSize ? <div className="mt-5 flex items-center justify-between border-t border-white/8 pt-4"><Button type="button" variant="outline" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - pageSize))} className="border-white/10 text-slate-200">السابق</Button><span className="text-xs text-slate-400">صفحة {Math.floor(offset / pageSize) + 1} من {pageCount}</span><Button type="button" variant="outline" disabled={offset + pageSize >= totalCount} onClick={() => setOffset((value) => value + pageSize)} className="border-white/10 text-slate-200">التالي</Button></div> : null}
            </CardContent></Card>
          </div>}
      </div>}
  </main></DashboardLayout>;
}
