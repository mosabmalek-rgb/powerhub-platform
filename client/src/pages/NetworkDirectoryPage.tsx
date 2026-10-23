import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SubscriberQuotaCard } from "@/components/SubscriberQuotaCard";
import { BulkSubscriberImport } from "@/components/BulkSubscriberImport";
import { OfflineWorkSyncPanel } from "@/components/OfflineWorkSyncPanel";
import { startLogin } from "@/const";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { parseDashboardKpiPeriod, useDashboardKpiPeriod, type DashboardKpiPeriodInitial } from "@/hooks/useDashboardKpiPeriod";
import { DashboardKpiPeriodFilter } from "@/components/DashboardKpiPeriodFilter";
import { downloadReportHtmlAsPdf } from "@/lib/report-pdf";
import { loadExcelJS } from "@/lib/lazy-report-deps";
import { trpc } from "@/lib/trpc";
import { filterAndSortDebtors, filterDebtorsByQuery } from "@/lib/debtor-search";
import { enqueueOfflineWork } from "@/lib/offline-work-queue";
import { can } from "@shared/powerhub-rbac";
import { Bolt, CircleAlert, Clock3, Copy, FileBarChart2, FileSpreadsheet, FileText, Loader2, Pencil, Plus, RefreshCw, UsersRound, WalletCards } from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

type DirectoryKind = "subscribers" | "generators";
type Values = Record<string, string | number | boolean | undefined>;
type SubscriberTypeFilter = "all" | "residential" | "commercial" | "institution" | "mosque";
const SUBSCRIBER_PAGE_SIZE = 20;
function normalizeSubscriberSearch(value: unknown) { return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ar").trim(); }
const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">{label}</span>{children}</label>;
}

export default function NetworkDirectoryPage({ kind, embedded = false }: { kind: DirectoryKind; embedded?: boolean }) {
  const { isAuthenticated, loading, user } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const routeSearchParams = useMemo(() => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search), []);
  const initialDebtorPeriod = useMemo(() => parseDashboardKpiPeriod(routeSearchParams.toString()), [routeSearchParams]);
  const initialDebtorScope = routeSearchParams.get("debtorScope") === "all" ? "all" as const : "branch" as const;
  const rawDebtorStatus = routeSearchParams.get("debtorStatus");
  const initialDebtorStatus = rawDebtorStatus === "overdue" || rawDebtorStatus === "partial" || rawDebtorStatus === "upcoming" ? rawDebtorStatus : "all";
  const focusDebtorCard = routeSearchParams.get("debtorFocus") === "1";
  const requestedSiteId = Number(routeSearchParams.get("siteId"));
  const [routeBranchApplied, setRouteBranchApplied] = useState(false);
  useEffect(() => {
    if (routeBranchApplied || !sitesQuery.data?.length || !Number.isInteger(requestedSiteId) || requestedSiteId <= 0) return;
    setRouteBranchApplied(true);
    if (sitesQuery.data.some((site) => site.id === requestedSiteId) && siteId !== requestedSiteId) {
      setSiteId(requestedSiteId);
    }
  }, [routeBranchApplied, requestedSiteId, setSiteId, siteId, sitesQuery.data]);
  const [editing, setEditing] = useState<any>(null);
  const [subscriberFormResetKey, setSubscriberFormResetKey] = useState(0);
  const [subscriberSearch, setSubscriberSearch] = useState("");
  const [debouncedSubscriberSearch, setDebouncedSubscriberSearch] = useState("");
  const [subscriberTypeFilter, setSubscriberTypeFilter] = useState<SubscriberTypeFilter>("all");
  const [subscriberPage, setSubscriberPage] = useState(1);
  const [addCardCollapsed, setAddCardCollapsed] = useState(() => !(kind === "subscribers" && new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("add") === "1"));
  const [isManuallyRefreshingSubscribers, setIsManuallyRefreshingSubscribers] = useState(false);
  const [directoryRefreshGeneration, setDirectoryRefreshGeneration] = useState(0);
  useEffect(() => {
    if (kind !== "subscribers") return;
    const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    if (params.get("add") === "1") setAddCardCollapsed(false);
    if (params.get("subscriberFocus") === "1") {
      window.requestAnimationFrame(() => {
        const input = document.getElementById("subscriber-search-input");
        input?.scrollIntoView({ behavior: "smooth", block: "center" });
        input?.focus({ preventScroll: true });
      });
    }
  }, [kind]);

  useEffect(() => {
    const normalizedSearch = normalizeSubscriberSearch(subscriberSearch);
    if (normalizedSearch === debouncedSubscriberSearch) return;
    const timeoutId = window.setTimeout(() => {
      setDebouncedSubscriberSearch(normalizedSearch);
      setSubscriberPage(1);
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [subscriberSearch, debouncedSubscriberSearch]);
  const enabled = Boolean(siteId && isAuthenticated);
  const subscriberDirectoryScopeKey = `${siteId ?? 0}:${debouncedSubscriberSearch}:${subscriberTypeFilter}`;
  const activeSubscriberDirectoryScopeRef = useRef("");
  activeSubscriberDirectoryScopeRef.current = enabled && kind === "subscribers" && siteId
    ? subscriberDirectoryScopeKey
    : "";
  const activeSubscriberPrefetchScopesRef = useRef(new Set<string>());
  const warmedSubscriberDirectoryRef = useRef(new Map<string, string>());
  const requestedSubscriberWarmupRef = useRef(new Map<string, {
    key: string;
    siteId: number;
    search: string;
    subscriptionType: SubscriberTypeFilter;
    totalPages: number;
  }>());
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const subscribersQuery = trpc.powerhub.subscribers.directoryPage.useQuery({
    siteId: siteId ?? 0,
    page: subscriberPage,
    pageSize: SUBSCRIBER_PAGE_SIZE,
    search: debouncedSubscriberSearch,
    ...(subscriberTypeFilter !== "all" ? { subscriptionType: subscriberTypeFilter } : {}),
  }, {
    enabled: enabled && kind === "subscribers",
    // The directory is stable: retain page data for an hour and in memory for two hours.
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
  });
  // Render page 1 as soon as it arrives; warm all remaining pages in the background in batches of 3.
  // Every page stays cached for two hours, and fresh for one hour, so ordinary paging is client-cache work.
  useEffect(() => {
    const totalPages = Number(subscribersQuery.data?.totalPages ?? 0);
    if (!enabled || kind !== "subscribers" || !siteId || !subscribersQuery.data || subscribersQuery.isPlaceholderData) return;

    const scopeKey = subscriberDirectoryScopeKey;
    const warmupKey = `${scopeKey}:${directoryRefreshGeneration}:${totalPages}`;
    const request = {
      key: warmupKey,
      siteId,
      search: debouncedSubscriberSearch,
      subscriptionType: subscriberTypeFilter,
      totalPages,
    };
    requestedSubscriberWarmupRef.current.set(scopeKey, request);
    if (warmedSubscriberDirectoryRef.current.get(scopeKey) === warmupKey || activeSubscriberPrefetchScopesRef.current.has(scopeKey)) return;

    activeSubscriberPrefetchScopesRef.current.add(scopeKey);
    void (async () => {
      try {
        while (activeSubscriberDirectoryScopeRef.current === scopeKey) {
          const target = requestedSubscriberWarmupRef.current.get(scopeKey);
          if (!target || warmedSubscriberDirectoryRef.current.get(scopeKey) === target.key) return;

          let requestChanged = false;
          for (let firstPage = 2; firstPage <= target.totalPages; firstPage += 3) {
            if (activeSubscriberDirectoryScopeRef.current !== scopeKey) return;
            if (requestedSubscriberWarmupRef.current.get(scopeKey)?.key !== target.key) {
              requestChanged = true;
              break;
            }
            const pages = Array.from(
              { length: Math.min(3, target.totalPages - firstPage + 1) },
              (_unused, index) => firstPage + index,
            );
            await Promise.all(pages.map((page) =>
              utils.powerhub.subscribers.directoryPage.prefetch({
                siteId: target.siteId,
                page,
                pageSize: SUBSCRIBER_PAGE_SIZE,
                search: target.search,
                ...(target.subscriptionType !== "all" ? { subscriptionType: target.subscriptionType } : {}),
              }, { staleTime: 60 * 60 * 1000, gcTime: 2 * 60 * 60 * 1000 }).catch(() => undefined),
            ));
          }

          if (requestChanged) continue;
          if (activeSubscriberDirectoryScopeRef.current !== scopeKey) return;
          if (requestedSubscriberWarmupRef.current.get(scopeKey)?.key === target.key) {
            warmedSubscriberDirectoryRef.current.set(scopeKey, target.key);
            return;
          }
        }
      } finally {
        activeSubscriberPrefetchScopesRef.current.delete(scopeKey);
      }
    })();
  }, [
    enabled,
    kind,
    siteId,
    subscriberDirectoryScopeKey,
    debouncedSubscriberSearch,
    subscriberTypeFilter,
    subscribersQuery.data?.totalPages,
    subscribersQuery.dataUpdatedAt,
    subscribersQuery.isPlaceholderData,
    directoryRefreshGeneration,
    utils,
  ]);
  useEffect(() => {
    if (!enabled || kind !== "subscribers") return;
    const intervalId = window.setInterval(() => {
      void utils.powerhub.subscribers.directoryPage.invalidate()
        .then(() => setDirectoryRefreshGeneration((generation) => generation + 1))
        .catch(() => {
          toast.error("تعذر تحديث قائمة المشتركين تلقائياً. استخدم زر التحديث اليدوي.");
        });
    }, 60 * 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, [enabled, kind, utils]);

  const refreshSubscriberDirectory = async () => {
    if (isManuallyRefreshingSubscribers || kind !== "subscribers") return;
    setIsManuallyRefreshingSubscribers(true);
    try {
      await utils.powerhub.subscribers.directoryPage.invalidate();
      setDirectoryRefreshGeneration((generation) => generation + 1);
      toast.success("تم تحديث قائمة المشتركين.");
    } catch {
      toast.error("تعذر تحديث قائمة المشتركين. تحقق من الاتصال ثم أعد المحاولة.");
    } finally {
      setIsManuallyRefreshingSubscribers(false);
    }
  };

  useEffect(() => {
    if (kind !== "subscribers" || !siteId) return;
    const onSubscriberDirectoryChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ siteId?: number }>).detail;
      if (detail?.siteId === siteId) {
        setDirectoryRefreshGeneration((generation) => generation + 1);
      }
    };
    window.addEventListener("powerhub:subscriber-directory-changed", onSubscriberDirectoryChanged);
    return () => window.removeEventListener("powerhub:subscriber-directory-changed", onSubscriberDirectoryChanged);
  }, [kind, siteId]);

  const subscriberQuotaQuery = trpc.powerhub.subscribers.quota.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && kind === "subscribers" });
  const financialOverviewQuery = trpc.powerhub.dashboard.financialOverview.useQuery({ siteId: siteId ?? 0, scope: "branch" }, { enabled: enabled && kind === "subscribers" });
  const generatorsQuery = trpc.powerhub.generators.list.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && kind === "generators" });
  const role = accessQuery.data?.role;
  const canEdit = kind === "subscribers" ? can(role, "manageSubscribers") : can(role, "manageGenerators");
  const data: any[] = kind === "subscribers" ? subscribersQuery.data?.items ?? [] : generatorsQuery.data ?? [];
  const searchTerm = normalizeSubscriberSearch(subscriberSearch);
  const visibleData: any[] = data;
  const totalSubscriberResults = kind === "subscribers" ? Number(subscribersQuery.data?.totalCount ?? 0) : visibleData.length;
  const totalSubscriberPages = Math.max(1, Number(subscribersQuery.data?.totalPages ?? 1));
  const currentSubscriberPage = Math.min(subscriberPage, totalSubscriberPages);
  const pageData: any[] = visibleData;
  const activeSite = useMemo(() => sitesQuery.data?.find((site) => site.id === siteId), [siteId, sitesQuery.data]);
  const refresh = (operation: "create" | "update" = "update"): void => {
    const siteScope = { siteId: siteId ?? 0 };
    const refreshTasks = kind === "subscribers"
      ? [
          utils.powerhub.subscribers.list.invalidate(siteScope),
          // Invalidate every cached page for this branch only; do not stale other tenants'
          // directory caches after a local create/update.
          utils.powerhub.subscribers.directoryPage.invalidate({ siteId: siteScope.siteId }),
          ...(operation === "create" ? [utils.powerhub.subscribers.quota.invalidate(siteScope)] : []),
          utils.powerhub.dashboard.financialOverview.invalidate({ ...siteScope, scope: "branch" }),
          utils.powerhub.dashboard.summary.invalidate(siteScope),
          utils.powerhub.audit.list.invalidate(siteScope),
        ]
      : [
          utils.powerhub.generators.list.invalidate(siteScope),
          utils.powerhub.dashboard.summary.invalidate(siteScope),
          utils.powerhub.audit.list.invalidate(siteScope),
        ];
    // Revalidation runs in the background after the server confirms the save.
    // The mutation success message must not wait for unrelated summaries or audit reads.
    void Promise.all(refreshTasks).then(() => {
      if (kind === "subscribers") setDirectoryRefreshGeneration((generation) => generation + 1);
    }).catch(() => {
      toast.warning("تم حفظ العملية، لكن تعذر تحديث بعض البيانات التابعة. أعد تحميل العرض للتحقق من أحدث النتائج.");
    });
  };

  const createSubscriber = trpc.powerhub.subscribers.create.useMutation({ onSuccess: (created) => { setSubscriberFormResetKey((key) => key + 1); refresh("create"); toast.success(`تمت إضافة المشترك. الرقم المرجعي: ${created.subscriberNo}`); }, onError: (e) => toast.error(e.message) });
  const updateSubscriber = trpc.powerhub.subscribers.update.useMutation({ onSuccess: () => { refresh("update"); setEditing(null); toast.success("تم تحديث المشترك."); }, onError: (e) => toast.error(e.message) });
  const createGenerator = trpc.powerhub.generators.create.useMutation({ onSuccess: () => { refresh("create"); toast.success("تمت إضافة المولد."); }, onError: (e) => toast.error(e.message) });
  const updateGenerator = trpc.powerhub.generators.update.useMutation({ onSuccess: () => { refresh("update"); setEditing(null); toast.success("تم تحديث المولد."); }, onError: (e) => toast.error(e.message) });

  const submitSubscriber = async (values: Values) => {
    const base = { siteId: siteId!, fullName: String(values.fullName), phone: String(values.phone), address: values.address ? String(values.address) : undefined, subscriptionType: values.subscriptionType as "residential" | "commercial" | "institution" | "mosque", serviceStatus: values.serviceStatus as "active" | "suspended" | "disconnected", openingReading: values.openingReading ? String(values.openingReading) : undefined, openingReadingAt: values.openingReadingAt ? String(values.openingReadingAt) : undefined, openingReadingApproved: Boolean(values.openingReading), openingReadingImageData: values.openingReadingImageData ? String(values.openingReadingImageData) : undefined, openingReadingImageMime: values.openingReadingImageMime ? String(values.openingReadingImageMime) as "image/jpeg" | "image/png" | "image/webp" : undefined };
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      if (!editing && (base.openingReading || base.openingReadingAt || base.openingReadingApproved || base.openingReadingImageData)) return toast.error("إضافة القراءة الافتتاحية تحتاج اتصالاً بالإنترنت؛ لم يتم حفظ المشترك كمسودة حتى لا تُفقد القراءة أو صورتها.");
      if (!user?.id) return toast.error("تعذر معرفة المستخدم الحالي لحفظ المسودة محلياً.");
      try {
        if (editing) await enqueueOfflineWork({ userId: user.id, siteId: siteId!, kind: "subscriber_update", payload: { subscriberId: editing.id, fullName: base.fullName, phone: base.phone, address: base.address, subscriptionType: base.subscriptionType, serviceStatus: base.serviceStatus, expectedUpdatedAt: new Date(editing.updatedAt).toISOString() } });
        else await enqueueOfflineWork({ userId: user.id, siteId: siteId!, kind: "subscriber_create", payload: { fullName: base.fullName, phone: base.phone, address: base.address, subscriptionType: base.subscriptionType } });
        setEditing(null);
        if (!editing) setSubscriberFormResetKey((key) => key + 1);
        toast.success(editing ? "حُفظ تعديل المشترك كمسودة محلية؛ راجع مركز المزامنة عند عودة الاتصال." : "حُفظ المشترك كمسودة محلية؛ سيُنشأ الرقم المرجعي عند قبول الخادم للمزامنة.");
      } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر حفظ المسودة المحلية."); }
      return;
    }
    if (editing) updateSubscriber.mutate({ siteId: base.siteId, fullName: base.fullName, phone: base.phone, address: base.address, subscriptionType: base.subscriptionType, serviceStatus: base.serviceStatus, id: editing.id });
    else createSubscriber.mutate(base);
  };
  const submitGenerator = async (values: Values) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      if (!user?.id) return toast.error("تعذر معرفة المستخدم الحالي لحفظ المسودة محلياً.");
      try {
        if (editing) {
          await enqueueOfflineWork({
            userId: user.id,
            siteId: siteId!,
            kind: "generator_update",
            payload: {
              generatorId: editing.id,
              name: String(values.name),
              ratedCapacityKw: values.ratedCapacityKw ? String(values.ratedCapacityKw) : undefined,
              fuelLevelLiters: String(values.fuelLevelLiters),
              operatingHours: String(values.operatingHours),
              status: values.status as "active" | "maintenance" | "stopped" | "offline",
              expectedUpdatedAt: new Date(editing.updatedAt).toISOString(),
            },
          });
          setEditing(null);
          toast.success("حُفظ تعديل المولد كمسودة محلية؛ سيُزامن تلقائياً عند عودة الاتصال.");
        } else {
          await enqueueOfflineWork({
            userId: user.id,
            siteId: siteId!,
            kind: "generator_create",
            payload: {
              code: String(values.code),
              name: String(values.name),
              serialNumber: values.serialNumber ? String(values.serialNumber) : undefined,
              ratedCapacityKw: values.ratedCapacityKw ? String(values.ratedCapacityKw) : undefined,
              fuelType: values.fuelType as "diesel" | "gasoline" | "gas" | "other",
            },
          });
          toast.success("حُفظ المولد كمسودة محلية؛ سيُنشأ في الخادم عند عودة الاتصال.");
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "تعذر حفظ المسودة المحلية.");
      }
      return;
    }
    if (editing) updateGenerator.mutate({ siteId: siteId!, id: editing.id, name: String(values.name), ratedCapacityKw: values.ratedCapacityKw ? String(values.ratedCapacityKw) : undefined, fuelLevelLiters: String(values.fuelLevelLiters), operatingHours: String(values.operatingHours), status: values.status as "active" | "maintenance" | "stopped" | "offline" });
    else createGenerator.mutate({ siteId: siteId!, code: String(values.code), name: String(values.name), serialNumber: values.serialNumber ? String(values.serialNumber) : undefined, ratedCapacityKw: String(values.ratedCapacityKw), fuelType: values.fuelType as "diesel" | "gasoline" | "gas" | "other" });
  };

  const wrapPage = (content: ReactNode) => embedded ? content : <DashboardLayout>{content}</DashboardLayout>;
  if (loading) return wrapPage(<Loading />);
  if (!isAuthenticated) return wrapPage(<LoginPrompt title={kind === "subscribers" ? "إدارة المشتركين" : "إدارة المولدات"} />);
  if (!user) return wrapPage(<LoginPrompt title={kind === "subscribers" ? "إدارة المشتركين" : "إدارة المولدات"} />);
  if (!sitesQuery.data?.length) return wrapPage(<EmptySetup />);
  const title = kind === "subscribers" ? "المشتركون" : "المحطات والمولدات";
  const Icon = kind === "subscribers" ? UsersRound : Bolt;
  const pending = createSubscriber.isPending || updateSubscriber.isPending || createGenerator.isPending || updateGenerator.isPending;

  return <DashboardLayout><div className="space-y-6 pb-12">
    <header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Icon className="h-4 w-4" />إدارة الشبكة</div><h1 className="mt-1 text-2xl font-extrabold text-white">{title}</h1><p className="mt-2 text-sm text-slate-400">{kind === "subscribers" ? "إضافة وتعديل بيانات الاشتراك وحالة الخدمة." : "القدرة والوقود وساعات التشغيل والحالة اللحظية."}</p></div><div className="flex items-center gap-2">{kind === "subscribers" ? <Button type="button" variant="outline" size="sm" onClick={() => void refreshSubscriberDirectory()} disabled={isManuallyRefreshingSubscribers || subscribersQuery.isFetching} className="shrink-0 border-white/10 text-slate-200"><RefreshCw className={`ml-2 h-4 w-4 ${isManuallyRefreshingSubscribers || subscribersQuery.isFetching ? "animate-spin" : ""}`} />تحديث القائمة</Button> : null}<select aria-label="فلتر الفرع الموحد" value={siteId ?? ""} onChange={(event) => { setSiteId(Number(event.target.value)); setEditing(null); setSubscriberPage(1); setSubscriberSearch(""); setDebouncedSubscriberSearch(""); setSubscriberTypeFilter("all"); }} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" value={site.id} key={site.id}>{site.name}</option>)}</select></div></header>
    <div className={kind === "subscribers" ? "space-y-6" : "grid gap-6 xl:grid-cols-[.8fr_1.2fr]"}>
      {canEdit ? <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5">{kind === "subscribers" ? <><div className="mb-4 flex items-center justify-between gap-3"><span className={addCardCollapsed && !editing ? "text-lg font-extrabold text-white sm:text-xl" : "text-sm font-bold text-slate-300"}>{editing ? "تعديل بيانات المشترك" : "إضافة مشترك"}</span><Button type="button" size="sm" variant="outline" onClick={() => setAddCardCollapsed((value) => !value)} className="border-white/10 text-slate-200">{addCardCollapsed ? "فتح البطاقة" : "طي البطاقة"}</Button></div>{!addCardCollapsed ? <SubscriberEditor key={`${editing?.id ?? "new"}-${subscriberFormResetKey}`} editing={editing} pending={pending} onCancel={() => setEditing(null)} onSubmit={submitSubscriber} /> : null}</> : <GeneratorEditor key={editing?.id ?? "new"} editing={editing} pending={pending} onCancel={() => setEditing(null)} onSubmit={submitGenerator} />}</CardContent></Card> : <ReadOnlyCard />}
      <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-4"><h2 className="font-bold text-white">سجل {title}</h2><span className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-slate-400">{kind === "subscribers" ? `${visibleData.length ? (currentSubscriberPage - 1) * SUBSCRIBER_PAGE_SIZE + 1 : 0}–${Math.min(currentSubscriberPage * SUBSCRIBER_PAGE_SIZE, totalSubscriberResults)} من ${totalSubscriberResults} نتيجة` : `${visibleData.length} من ${data.length} سجل`}</span></div><div className="p-5">{kind === "subscribers" ? <div className="mb-4 grid gap-3 sm:grid-cols-2"><label className="block text-xs text-slate-400"><span className="mb-1 block">بحث ذكي وسريع</span><input id="subscriber-search-input" aria-label="بحث ذكي في سجل المشتركين" list={`subscriber-autocomplete-${siteId}`} value={subscriberSearch} onChange={(event) => setSubscriberSearch(event.target.value)} placeholder="اسم المشترك أو الرقم المرجعي أو الهاتف…" className={inputClass} /><datalist id={`subscriber-autocomplete-${siteId}`}>{data.slice(0,200).flatMap((row) => [<option key={`name-${row.id}`} value={row.fullName}/>,<option key={`number-${row.id}`} value={row.subscriberNo}/>,<option key={`phone-${row.id}`} value={row.phone}/>])}</datalist></label><label className="block text-xs text-slate-400"><span className="mb-1 block">نوع المشترك</span><select aria-label="فلتر نوع المشترك" value={subscriberTypeFilter} onChange={(event) => { setSubscriberTypeFilter(event.target.value as SubscriberTypeFilter); setSubscriberPage(1); }} className={inputClass}><option value="all">كل الأنواع</option><option value="residential">سكني</option><option value="commercial">تجاري</option><option value="institution">مؤسسات</option><option value="mosque">مساجد</option></select></label></div> : null}{pageData.length ? <div className="space-y-2">{pageData.map((item) => <RecordRow key={item.id} kind={kind} item={item} canEdit={canEdit} onEdit={() => { setEditing(item); setAddCardCollapsed(false); }} onOpenStatement={kind === "subscribers" && siteId ? () => setLocation(`/subscriber-statement/${item.id}?siteId=${siteId}`) : undefined} />)}</div> : <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500">{kind === "subscribers" && (searchTerm || subscriberTypeFilter !== "all") ? "لا توجد نتائج مطابقة للبحث أو نوع المشترك المحدد." : `لا توجد سجلات في ${activeSite?.name}.`} {canEdit && !searchTerm && subscriberTypeFilter === "all" ? "استخدم النموذج لإضافة أول سجل." : ""}</div>}{kind === "subscribers" && totalSubscriberResults > SUBSCRIBER_PAGE_SIZE ? <nav aria-label="صفحات سجل المشتركين" className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-4"><span className="text-xs text-slate-400">عرض 20 مشتركاً كحد أقصى في الصفحة</span><div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={currentSubscriberPage === 1} onClick={() => setSubscriberPage(1)} className="border-white/10 text-slate-200">الأولى</Button><Button type="button" variant="outline" size="sm" disabled={currentSubscriberPage === 1} onClick={() => setSubscriberPage((page) => Math.max(1, page - 1))} className="border-white/10 text-slate-200">السابق</Button><span aria-live="polite" className="min-w-24 text-center text-xs text-slate-300">صفحة {currentSubscriberPage} من {totalSubscriberPages}</span><Button type="button" variant="outline" size="sm" disabled={currentSubscriberPage >= totalSubscriberPages} onClick={() => setSubscriberPage((page) => Math.min(totalSubscriberPages, page + 1))} className="border-white/10 text-slate-200">التالي</Button><Button type="button" variant="outline" size="sm" disabled={currentSubscriberPage >= totalSubscriberPages} onClick={() => setSubscriberPage(totalSubscriberPages)} className="border-white/10 text-slate-200">الأخيرة</Button></div></nav> : null}</div></CardContent></Card>
    </div>
    {kind === "generators" && canEdit && user?.id ? <OfflineWorkSyncPanel siteId={siteId!} userId={user.id} compact /> : null}
    {kind === "subscribers" ? <><SubscriberPortalGuide /><SubscriberQuotaCard quota={subscriberQuotaQuery.data} />{canEdit ? <><OfflineWorkSyncPanel siteId={siteId!} userId={user.id!} compact /><BulkSubscriberImport siteId={siteId!} onSaved={async () => { refresh("create"); }} /></> : null}<SubscriberFinancialOverview overview={financialOverviewQuery.data} /><SubscriberDebtorWorkspace siteId={siteId!} canRemind={can(role, "manageMessaging")} initialPeriod={initialDebtorPeriod} initialScope={initialDebtorScope} initialStatus={initialDebtorStatus} autoFocus={focusDebtorCard} /></> : null}
  </div></DashboardLayout>;
}

function SubscriberPortalGuide() {
  return <Card className="border-sky-400/20 bg-sky-400/[.045] shadow-panel"><CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-sky-100">إرشاد بوابة الاستعلامات للمشترك</p><p className="mt-1 text-sm leading-6 text-slate-300">بعد إنشاء المشترك، استخدم زر <strong className="text-sky-100">نسخ الرقم المرجعي</strong> في بطاقته أدناه ثم شاركه معه. يفتح رابط بوابة المولد ويدخل الرقم المرجعي مع رقم هاتفه الدولي المسجل لعرض فواتيره واستهلاكه.</p></div><div className="shrink-0 rounded-xl border border-sky-300/20 bg-[#0D1117]/40 px-3 py-2 text-center text-xs text-sky-100"><span className="block font-bold">مفتاح البحث</span><span className="mt-1 block" dir="ltr">Reference No. + Phone</span></div></CardContent></Card>;
}

function SubscriberDebtorWorkspace({
  siteId,
  canRemind,
  initialPeriod,
  initialScope,
  initialStatus,
  autoFocus = false,
}: {
  siteId: number;
  canRemind: boolean;
  initialPeriod: DashboardKpiPeriodInitial;
  initialScope: "branch" | "all";
  initialStatus: "all" | "overdue" | "partial" | "upcoming";
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "overdue" | "partial" | "upcoming">(initialStatus);
  const [sort, setSort] = useState<"priority" | "balance" | "age">("priority");
  const period = useDashboardKpiPeriod(siteId, initialPeriod);
  const periodMetricsQuery = trpc.powerhub.dashboard.periodMetrics.useQuery({
    siteId,
    scope: initialScope,
    startDate: period.startDate,
    endDate: period.endDate,
    includeDetails: true,
  }, { enabled: Boolean(siteId && period.isReady), staleTime: 10_000 });
  const reminder = trpc.powerhub.notifications.sendPaymentReminderSms.useMutation({
    onSuccess: (result) => toast.success(result.status === "submitted" ? "تم إرسال تذكير SMS إلى المشترك." : "وُضع تذكير SMS في الطابور؛ راجع سجل الإشعارات."),
    onError: (error) => toast.error(error.message),
  });
  const exportReportRef = useRef<HTMLDivElement>(null);
  const didAutoFocus = useRef(false);
  const rows = filterAndSortDebtors(periodMetricsQuery.data?.outstandingInvoices ?? [], query, status, sort);
  const statusLabel = (row: any) => row.isOverdue && row.partialInvoices
    ? "متأخر · دفعة جزئية"
    : row.partialInvoices
      ? "دفعة جزئية"
      : row.isOverdue
        ? "متأخر"
        : "مستحق";
  const statusFilterLabel = status === "all" ? "كل الفواتير ذات الرصيد" : status === "overdue" ? "متأخر عن الاستحقاق" : status === "partial" ? "دفعة جزئية" : "لم يتجاوز الاستحقاق";
  const sortLabel = sort === "priority" ? "الأولوية" : sort === "balance" ? "أعلى رصيد" : "أقدم دين";
  const format = (value: unknown) => new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(Number(value ?? 0));
  const formatDate = (value: unknown) => value ? new Date(String(value)).toLocaleDateString("ar-PS", { timeZone: "Asia/Gaza" }) : "—";

  useEffect(() => {
    if (!autoFocus || didAutoFocus.current || !period.isReady || (!periodMetricsQuery.data && !periodMetricsQuery.isError)) return;
    didAutoFocus.current = true;
    window.requestAnimationFrame(() => {
      document.getElementById("subscriber-arrears")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [autoFocus, period.isReady, periodMetricsQuery.data, periodMetricsQuery.isError]);

  const exportRows = rows.map((row: any) => ({
    branch: row.siteName ?? "—",
    subscriber: row.subscriber ?? "مشترك غير محدد",
    subscriberNo: row.subscriberNo ?? "—",
    invoiceNo: row.invoiceNo ?? "—",
    issueDate: formatDate(row.issueDate),
    outstanding: Number(row.outstanding ?? 0),
    dueDate: formatDate(row.dueDate),
    status: statusLabel(row),
  }));
  const exportTitle = initialScope === "all" ? "متأخرات جميع الأفرع" : "متأخرات المشتركين";
  const reportColumns = initialScope === "all"
    ? ["الفرع", "المشترك", "الرقم المرجعي", "رقم الفاتورة", "تاريخ الفاتورة", "الرصيد المتبقي (شيكل)", "تاريخ الاستحقاق", "الحالة"]
    : ["المشترك", "الرقم المرجعي", "رقم الفاتورة", "تاريخ الفاتورة", "الرصيد المتبقي (شيكل)", "تاريخ الاستحقاق", "الحالة"];
  const valuesForRow = (row: typeof exportRows[number]) => initialScope === "all"
    ? [row.branch, row.subscriber, row.subscriberNo, row.invoiceNo, row.issueDate, row.outstanding, row.dueDate, row.status]
    : [row.subscriber, row.subscriberNo, row.invoiceNo, row.issueDate, row.outstanding, row.dueDate, row.status];

  const downloadExcel = async () => {
    if (!periodMetricsQuery.data || !exportRows.length) return toast.error("لا توجد نتائج مطابقة لتصديرها.");
    try {
      const { default: ExcelJS } = await loadExcelJS();
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "PowerHub";
      workbook.created = new Date();
      const sheet = workbook.addWorksheet("المتأخرات", { views: [{ rightToLeft: true }] });
      sheet.addRow([exportTitle]);
      sheet.addRow(["الفترة", `${period.startDate} إلى ${period.endDate}`]);
      sheet.addRow(["الحالة", statusFilterLabel, "الترتيب", sortLabel]);
      sheet.addRow([]);
      sheet.addRow(reportColumns);
      exportRows.forEach((row) => sheet.addRow(valuesForRow(row)));
      sheet.columns = (initialScope === "all"
        ? [22, 28, 18, 18, 16, 22, 16, 24]
        : [30, 18, 18, 16, 22, 16, 24]
      ).map((width) => ({ width }));
      [1, 5].forEach((rowNumber) => {
        const row = sheet.getRow(rowNumber);
        row.font = { bold: true, color: { argb: "FFFFFFFF" } };
        row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } };
        row.height = rowNumber === 1 ? 30 : 26;
      });
      for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
        sheet.getRow(rowNumber).alignment = { vertical: "middle", horizontal: "right", wrapText: true };
      }
      sheet.views = [{ state: "frozen", ySplit: 5, rightToLeft: true }];
      const buffer = await workbook.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `powerhub-arrears-${period.startDate}-to-${period.endDate}.xlsx`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("تم تصدير متأخرات الفترة المحددة إلى Excel.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذر تجهيز ملف Excel للمتأخرات.");
    }
  };

  const downloadPdf = async () => {
    if (!periodMetricsQuery.data || !exportRows.length || !exportReportRef.current) return toast.error("لا توجد نتائج مطابقة لتصديرها.");
    try {
      await downloadReportHtmlAsPdf(exportReportRef.current, `متأخرات-${period.startDate}-إلى-${period.endDate}.pdf`, {
        landscape: true,
        title: `${exportTitle} — ${period.startDate} إلى ${period.endDate}`,
      });
      toast.success("تم تصدير متأخرات الفترة المحددة إلى PDF.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذر إنشاء PDF للمتأخرات.");
    }
  };

  const focusHeader = initialScope === "all" ? "بحث ومتابعة متأخرات جميع الأفرع" : "بحث ومتابعة المتأخرات";
  const totalOpenCount = periodMetricsQuery.data?.outstandingInvoices?.length ?? 0;
  const columnWidths = initialScope === "all"
    ? ["10%", "20%", "9%", "9%", "10%", "11%", "10%", "11%", "10%"]
    : ["20%", "10%", "10%", "12%", "13%", "13%", "12%", "10%"];

  return (
    <section id="subscriber-arrears" className="scroll-mt-6 space-y-4">
      <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel">
        <CardContent className="p-5">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h2 className="font-bold text-white">{focusHeader}</h2>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                يعرض الرصيد المفتوح على الفواتير الصادرة خلال الفترة المحددة. قيمة المتأخرات تحسب فقط الأرصدة التي تجاوزت تاريخ الاستحقاق، بينما يمكنك عرض الفواتير الجزئية أو المستحقة لاحقاً.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void downloadPdf()} disabled={!periodMetricsQuery.data || rows.length === 0} className="border-rose-400/30 text-rose-200 hover:bg-rose-400/10">
                <FileText className="ml-2 h-4 w-4" /> PDF
              </Button>
              <Button type="button" variant="outline" onClick={() => void downloadExcel()} disabled={!periodMetricsQuery.data || rows.length === 0} className="border-emerald-400/30 text-emerald-200 hover:bg-emerald-400/10">
                <FileSpreadsheet className="ml-2 h-4 w-4" /> Excel
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <DashboardKpiPeriodFilter
        value={period.preset}
        onChange={period.setPreset}
        startDate={period.startDate}
        endDate={period.endDate}
        onStartDateChange={period.setStartDate}
        onEndDateChange={period.setEndDate}
        disabled={period.isLoading}
        error={period.isError || periodMetricsQuery.isError}
        onRetry={() => { period.retry(); void periodMetricsQuery.refetch(); }}
      />
      <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel">
        <CardContent className="p-5">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <h3 className="font-bold text-white">تفاصيل الفواتير ذات الرصيد</h3>
              <p className="mt-1 text-xs text-slate-500">الفترة: {period.startDate} — {period.endDate} · الحالة: {statusFilterLabel}</p>
            </div>
            <div className="grid w-full gap-2 sm:grid-cols-3 xl:max-w-3xl">
              <input aria-label="بحث المتأخرات" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="اسم المشترك أو الرقم المرجعي أو رقم الفاتورة" className={inputClass} dir="auto" />
              <select aria-label="حالة المتأخرات" value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className={inputClass}>
                <option className="bg-[#111823]" value="all">كل الفواتير ذات الرصيد</option>
                <option className="bg-[#111823]" value="overdue">متأخر عن الاستحقاق</option>
                <option className="bg-[#111823]" value="partial">دفعة جزئية</option>
                <option className="bg-[#111823]" value="upcoming">لم يتجاوز الاستحقاق</option>
              </select>
              <select aria-label="ترتيب المتأخرات" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className={inputClass}>
                <option className="bg-[#111823]" value="priority">ترتيب الأولوية</option>
                <option className="bg-[#111823]" value="balance">أعلى رصيد متبقٍ</option>
                <option className="bg-[#111823]" value="age">الأقدم استحقاقًا</option>
              </select>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
            <span>{periodMetricsQuery.isLoading || !period.isReady ? "جارٍ تحميل النتائج…" : periodMetricsQuery.isError ? "تعذر تحميل فواتير الفترة؛ أعد المحاولة." : `${rows.length} فاتورة تطابق الفلتر الحالي`}</span>
            <span>إجمالي الفواتير ذات الرصيد في الفترة: {totalOpenCount}</span>
          </div>
          <div className="mt-4">
            {periodMetricsQuery.isError ? (
              <p role="alert" className="px-4 py-8 text-center text-sm text-rose-200">تعذر تحميل المتأخرات للفترة المحددة. استخدم «إعادة المحاولة» في بطاقة الفلتر.</p>
            ) : rows.length ? (
              <>
                <div className="grid gap-3 xl:hidden">
                  {rows.map((row: any) => (
                    <article key={"mobile-" + row.siteId + "-" + row.invoiceId} className="min-w-0 rounded-xl border border-white/8 bg-white/[.02] p-4">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words font-bold leading-6 text-white">{row.subscriber ?? "مشترك غير محدد"}</p>
                          <p className="mt-1 break-all font-display text-sm text-slate-400" dir="ltr">{row.subscriberNo ?? "—"}</p>
                          {initialScope === "all" ? <p className="mt-1 break-words text-sm text-slate-500">{row.siteName ?? "—"}</p> : null}
                        </div>
                        <Badge className={row.isOverdue ? "shrink-0 bg-rose-400/10 text-sm text-rose-300" : row.partialInvoices ? "shrink-0 bg-amber-400/10 text-amber-200 text-sm" : "shrink-0 bg-sky-400/10 text-sky-200 text-sm"}>{statusLabel(row)}</Badge>
                      </div>
                      <div className="mt-4 grid min-w-0 grid-cols-2 gap-x-3 gap-y-3 text-sm">
                        <div className="min-w-0"><p className="text-sm text-slate-500">الرصيد المتبقي</p><p className="mt-1 break-words font-bold tabular-nums text-rose-200">{format(row.outstanding)}</p></div>
                        <div className="min-w-0"><p className="text-sm text-slate-500">تاريخ الاستحقاق</p><p className="mt-1 text-slate-300">{formatDate(row.dueDate)}</p></div>
                        <div className="min-w-0"><p className="text-sm text-slate-500">رقم الفاتورة</p><p className="mt-1 break-all font-display text-sm text-[#F5B800]" dir="ltr">{row.invoiceNo ?? "—"}</p></div>
                        <div className="min-w-0"><p className="text-sm text-slate-500">تاريخ الفاتورة</p><p className="mt-1 text-slate-300">{formatDate(row.issueDate)}</p></div>
                      </div>
                      {canRemind && row.invoiceId ? <Button size="sm" disabled={reminder.isPending && reminder.variables?.invoiceId === row.invoiceId} onClick={() => reminder.mutate({ siteId: Number(row.siteId ?? siteId), invoiceId: row.invoiceId })} className="mt-3 h-9 min-h-0 w-full px-2 py-1 text-sm bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]">{reminder.isPending && reminder.variables?.invoiceId === row.invoiceId ? "جارٍ الإرسال…" : "إرسال تذكير"}</Button> : null}
                    </article>
                  ))}
                </div>
                <div className="hidden overflow-hidden rounded-xl border border-white/8 xl:block">
              <table className="w-full table-fixed border-collapse text-sm leading-5">
                <colgroup>{columnWidths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
                <thead className="bg-white/[.025] text-right text-sm leading-5 text-slate-400">
                  <tr>
                    {initialScope === "all" ? <th className="px-2 py-2">الفرع</th> : null}
                    <th className="px-2 py-2">المشترك</th>
                    <th className="px-1 py-2 text-center">الرقم المرجعي</th>
                    <th className="px-1 py-2 text-center">رقم الفاتورة</th>
                    <th className="px-1 py-2 text-center">تاريخ الفاتورة</th>
                    <th className="px-1 py-2 text-center">الرصيد المتبقي</th>
                    <th className="px-1 py-2 text-center">تاريخ الاستحقاق</th>
                    <th className="px-1 py-2">الحالة</th>
                    <th className="px-1 py-2 text-center">تذكير التسديد</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row: any) => (
                    <tr className="border-t border-white/7 align-middle" key={`${row.siteId}-${row.invoiceId}`}>
                      {initialScope === "all" ? <td className="break-words px-2 py-2 text-[11px] leading-4 text-slate-300">{row.siteName ?? "—"}</td> : null}
                      <td className="min-w-0 break-words px-2 py-2 text-sm font-bold leading-5 text-white [overflow-wrap:anywhere]">{row.subscriber ?? "مشترك غير محدد"}</td>
                      <td className="min-w-0 break-all px-1 py-2 text-center font-mono text-sm tabular-nums text-slate-300 [overflow-wrap:anywhere]" dir="ltr">{row.subscriberNo ?? "—"}</td>
                      <td className="min-w-0 break-all px-1 py-2 text-center font-mono text-sm tabular-nums text-[#F5B800] [overflow-wrap:anywhere]" dir="ltr">{row.invoiceNo ?? "—"}</td>
                      <td className="min-w-0 break-words px-1 py-2 text-center text-sm leading-5 text-slate-300 [overflow-wrap:anywhere]">{formatDate(row.issueDate)}</td>
                      <td className="whitespace-normal break-words px-1 py-2 text-center text-sm font-bold tabular-nums leading-5 text-rose-200">{format(row.outstanding)}</td>
                      <td className="min-w-0 break-words px-1 py-2 text-center text-sm leading-5 text-slate-300 [overflow-wrap:anywhere]">{formatDate(row.dueDate)}</td>
                      <td className="min-w-0 break-words px-1 py-2"><Badge className={row.isOverdue ? "max-w-full whitespace-normal bg-rose-400/10 text-rose-300 text-sm [overflow-wrap:anywhere]" : row.partialInvoices ? "max-w-full whitespace-normal bg-amber-400/10 text-amber-200 text-sm [overflow-wrap:anywhere]" : "max-w-full whitespace-normal bg-sky-400/10 text-sky-200 text-sm [overflow-wrap:anywhere]"}>{statusLabel(row)}</Badge></td>
                      <td className="px-1 py-2 text-center">{canRemind && row.invoiceId ? <Button size="sm" disabled={reminder.isPending && reminder.variables?.invoiceId === row.invoiceId} onClick={() => reminder.mutate({ siteId: Number(row.siteId ?? siteId), invoiceId: row.invoiceId })} className="h-9 min-h-0 w-full min-w-0 whitespace-normal break-words bg-[#F5B800] px-1 py-1 text-sm leading-4 text-[#0D1117] hover:bg-[#ffd23f]">{reminder.isPending && reminder.variables?.invoiceId === row.invoiceId ? "جارٍ الإرسال…" : "إرسال تذكير"}</Button> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
                </div>
              </>
            ) : (
              <p className="px-4 py-8 text-center text-sm text-slate-500">
                {periodMetricsQuery.isLoading || !period.isReady ? "جارٍ تحميل بيانات الفترة…" : query.trim() || status !== "all" ? "لا توجد فواتير تطابق البحث أو الحالة المحددة في الفترة الحالية." : "لا توجد فواتير بأرصدة مفتوحة ضمن الفترة المحددة."}
              </p>
            )}
          </div>
          {!canRemind ? <p className="mt-4 text-xs leading-5 text-slate-500">يظهر زر التذكير للمالك أو المدير أو المحاسب المخول بإدارة المراسلات فقط.</p> : null}
        </CardContent>
      </Card>
      <div ref={exportReportRef} dir="rtl" className="fixed left-[-30000px] top-0 w-[1500px] bg-white p-8 text-slate-900">
        <h1 className="mb-2 text-2xl font-extrabold">{exportTitle}</h1>
        <p className="mb-1 text-sm">الفترة: {period.startDate} — {period.endDate}</p>
        <p className="mb-5 text-sm">الحالة: {statusFilterLabel} · الترتيب: {sortLabel} · عدد الفواتير: {exportRows.length}</p>
        <table className="w-full border-collapse text-sm">
          <thead><tr>{reportColumns.map((column) => <th key={column} className="border border-slate-400 bg-slate-100 p-2 text-right">{column}</th>)}</tr></thead>
          <tbody>{exportRows.map((row, index) => <tr key={`${row.invoiceNo}-${index}`}>{valuesForRow(row).map((value, cellIndex) => <td key={cellIndex} className="border border-slate-300 p-2 align-top break-words">{String(value ?? "—")}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function SubscriberFinancialOverview({ overview }: { overview: any }) {
  const format = (value: unknown) => new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(Number(value ?? 0));
  return <section className="grid gap-4 sm:grid-cols-3"><Card className="border-rose-400/20 bg-rose-400/[.055] shadow-panel"><CardContent className="p-5"><div className="flex items-center justify-between text-rose-200"><span className="text-sm font-bold">إجمالي الأرصدة المفتوحة</span><CircleAlert className="h-4 w-4" /></div><p className="mt-4 font-display text-3xl font-extrabold text-white">{format(overview?.outstanding.total)}</p><p className="mt-2 text-xs text-rose-100/70">الرصيد الإجمالي على {format(overview?.outstanding.accountCount)} مشتركاً لديه رصيد مفتوح.</p></CardContent></Card><Card className="border-amber-400/20 bg-amber-400/[.055] shadow-panel"><CardContent className="p-5"><div className="flex items-center justify-between text-amber-200"><span className="text-sm font-bold">دفعات جزئية</span><WalletCards className="h-4 w-4" /></div><p className="mt-4 font-display text-3xl font-extrabold text-white">{format(overview?.outstanding.partialInvoices)}</p><p className="mt-2 text-xs text-amber-100/70">عدد الفواتير المدفوعة جزئياً التي بقي عليها رصيد.</p></CardContent></Card><Card className="border-sky-400/20 bg-sky-400/[.055] shadow-panel"><CardContent className="p-5"><div className="flex items-center justify-between text-sky-200"><span className="text-sm font-bold">متأخر عن الاستحقاق</span><Clock3 className="h-4 w-4" /></div><p className="mt-4 font-display text-3xl font-extrabold text-white">{format(overview?.outstanding.overdue)}</p><p className="mt-2 text-xs text-sky-100/70">إجمالي الأرصدة التي تجاوزت تاريخ الاستحقاق المحدد.</p></CardContent></Card></section>;
}
async function copySubscriberReference(subscriberNo: string) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(subscriberNo);
    else {
      const input = document.createElement("textarea");
      input.value = subscriberNo;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(input);
      if (!copied) throw new Error("copy_failed");
    }
    toast.success(`تم نسخ الرقم المرجعي: ${subscriberNo}`);
  } catch {
    toast.error("تعذر نسخ الرقم المرجعي. انسخه يدوياً من السجل.");
  }
}

function SubscriberEditor({ editing, pending, onCancel, onSubmit }: {
  editing: any;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: Values) => void;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rawImage = form.get("openingReadingImage");
    const image = rawImage instanceof File && rawImage.size > 0 ? rawImage : null;
    const reading = String(form.get("openingReading") || "").trim();
    const readingAt = String(form.get("openingReadingAt") || "").trim();


    if (image && image.size > 7 * 1024 * 1024) {
      window.alert("يجب ألا تتجاوز صورة القراءة الافتتاحية 7 ميغابايت.");
      return;
    }
    if (!editing && (readingAt || image) && !reading) {
      window.alert("أدخل قيمة القراءة الافتتاحية قبل إضافة صورتها أو اعتمادها.");
      return;
    }

    const submit = (openingReadingImageData?: string) => onSubmit({
      fullName: String(form.get("fullName")),
      phone: String(form.get("phone")),
      address: String(form.get("address") || ""),
      subscriptionType: String(form.get("subscriptionType")),
      serviceStatus: String(form.get("serviceStatus")),
      openingReading: reading || undefined,
      openingReadingAt: readingAt || undefined,
      openingReadingApproved: Boolean(reading),
      openingReadingImageData,
      openingReadingImageMime: image?.type || undefined,
    });

    if (image && image.size) {
      const reader = new FileReader();
      reader.onload = () => submit(String(reader.result).split(",")[1] || "");
      reader.readAsDataURL(image);
    } else {
      submit();
    }
  };

  return (
    <>
      <EditorTitle
        text={editing ? "تعديل مشترك" : "إضافة مشترك"}
        editing={Boolean(editing)}
        onCancel={onCancel}
      />
      <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
        {editing && (
          <Field label="الرقم المرجعي">
            <input value={editing.subscriberNo} readOnly className={`${inputClass} opacity-60`} dir="ltr" />
          </Field>
        )}
        <Field label="الاسم">
          <input required name="fullName" defaultValue={editing?.fullName} className={inputClass} />
        </Field>
        <Field label="رقم الجوال">
          <input
            required
            type="tel"
            name="phone"
            defaultValue={editing?.phone}
            className={inputClass}
            dir="ltr"
          />
        </Field>
        <Field label="العنوان">
          <input name="address" defaultValue={editing?.address ?? ""} className={inputClass} />
        </Field>
        <Field label="نوع الاشتراك">
          <select name="subscriptionType" defaultValue={editing?.subscriptionType ?? "residential"} className={inputClass}>
            <option value="residential">سكني</option>
            <option value="commercial">تجاري</option>
            <option value="institution">مؤسسات</option>
            <option value="mosque">مساجد</option>
          </select>
        </Field>
        <Field label="حالة الخدمة">
          <select name="serviceStatus" defaultValue={editing?.serviceStatus ?? "active"} className={inputClass}>
            <option value="active">نشط</option>
            <option value="suspended">معلق</option>
            <option value="disconnected">مفصول</option>
          </select>
        </Field>

        {!editing && (
          <>
            <Field label="القراءة الافتتاحية (اختيارية)">
              <input
                name="openingReading"
                type="number"
                min="0"
                step="0.01"
                placeholder="مثال: 1250.50"
                className={inputClass}
                dir="ltr"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">
                تُستخدم كنقطة بداية ولا تُنشئ فاتورة.
              </p>
            </Field>
            <Field label="تاريخ القراءة الافتتاحية (اختياري)">
              <input name="openingReadingAt" type="datetime-local" className={inputClass} dir="ltr" />
            </Field>
            <Field label="صورة العداد (اختيارية)">
              <input
                name="openingReadingImage"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="block w-full text-sm text-slate-300"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">
                الصورة اختيارية، والحد الأقصى 7 ميغابايت.
              </p>
            </Field>
            <p className="text-xs leading-5 text-slate-500">
              ستُعتمد القراءة الافتتاحية تلقائيًا كنقطة بداية ولن تصدر عنها فاتورة استهلاك.
            </p>
          </>
        )}

        <div className="grid gap-2 sm:grid-cols-2">{!editing && <Button type="button" variant="outline" onClick={(event) => event.currentTarget.form?.reset()} className="w-full border-white/10 text-slate-300">إفراغ الحقول</Button>}<SubmitButton text={editing ? "حفظ التعديلات" : "إضافة المشترك"} pending={pending} /></div>
      </form>
    </>
  );
}

function GeneratorEditor({ editing, pending, onCancel, onSubmit }: { editing: any; pending: boolean; onCancel: () => void; onSubmit: (values: Values) => void }) {
  return <><EditorTitle text={editing ? "تعديل مولد" : "إضافة مولد"} editing={Boolean(editing)} onCancel={onCancel} /><form className="mt-5 space-y-4" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); onSubmit(editing ? { name: String(f.get("name")), ratedCapacityKw: String(f.get("ratedCapacityKw") || "").trim() || undefined, fuelLevelLiters: String(f.get("fuelLevelLiters")), operatingHours: String(f.get("operatingHours")), status: String(f.get("status")) } : { code: String(f.get("code")), name: String(f.get("name")), serialNumber: String(f.get("serialNumber") || ""), ratedCapacityKw: String(f.get("ratedCapacityKw") || "").trim() || undefined, fuelType: String(f.get("fuelType")) }); }}><Field label="رمز المولد">{editing ? <input value={editing.code} readOnly className={`${inputClass} opacity-60`} dir="ltr" /> : <input required name="code" placeholder="GEN-01" className={inputClass} dir="ltr" />}</Field><Field label="الاسم"><input required name="name" defaultValue={editing?.name} className={inputClass} /></Field><Field label="القدرة kW (اختياري)"><input name="ratedCapacityKw" defaultValue={editing?.ratedCapacityKw ?? ""} type="number" min="1" step="0.001" className={inputClass} dir="ltr" /></Field>{editing ? <><Field label="الوقود باللتر"><input required name="fuelLevelLiters" defaultValue={editing.fuelLevelLiters} type="number" min="0" step="0.01" className={inputClass} dir="ltr" /></Field><Field label="ساعات التشغيل"><input required name="operatingHours" defaultValue={editing.operatingHours} type="number" min="0" step="0.01" className={inputClass} dir="ltr" /></Field><Field label="الحالة"><select name="status" defaultValue={editing.status} className={inputClass}><option value="active">يعمل</option><option value="maintenance">صيانة</option><option value="stopped">متوقف</option><option value="offline">غير متصل</option></select></Field></> : <><Field label="الرقم التسلسلي"><input name="serialNumber" className={inputClass} dir="ltr" /></Field><Field label="نوع الوقود"><select name="fuelType" className={inputClass}><option value="diesel">ديزل</option><option value="gasoline">بنزين</option><option value="gas">غاز</option><option value="other">آخر</option></select></Field></>}<SubmitButton text={editing ? "حفظ التعديلات" : "إضافة المولد"} pending={pending} /></form></>;
}

function RecordRow({ kind, item, canEdit, onEdit, onOpenStatement }: { kind: DirectoryKind; item: any; canEdit: boolean; onEdit: () => void; onOpenStatement?: () => void }) {
  const subscriber = kind === "subscribers";
  return <div className="flex flex-col gap-3 rounded-xl border border-white/7 bg-white/[0.018] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-white">{subscriber ? item.fullName : item.name}</p><p className="mt-1 text-xs text-slate-500">{subscriber ? `${item.subscriberNo} · ${item.phone} · ${item.subscriptionType === "commercial" ? "تجاري" : item.subscriptionType === "institution" ? "مؤسسات" : item.subscriptionType === "mosque" ? "مساجد" : "سكني"}` : `${item.code} · ${item.ratedCapacityKw ? `${item.ratedCapacityKw} kW` : "القدرة غير محددة"} · ${item.operatingHours} ساعة`}</p></div><div className="flex flex-wrap items-center gap-2">{subscriber ? <><Badge className={item.serviceStatus === "active" ? "bg-emerald-400/10 text-emerald-400" : "bg-rose-400/10 text-rose-400"}>{item.serviceStatus === "active" ? "نشط" : item.serviceStatus === "suspended" ? "معلق" : "مفصول"}</Badge><Button size="sm" variant="outline" className="border-sky-300/25 text-sky-100 hover:bg-sky-300/10 hover:text-sky-50" onClick={() => void copySubscriberReference(item.subscriberNo)}><Copy className="ml-1.5 h-3.5 w-3.5" />نسخ الرقم المرجعي</Button>{onOpenStatement ? <Button size="sm" variant="outline" className="border-[#F5B800]/25 text-[#F5B800] hover:bg-[#F5B800]/10 hover:text-[#ffd23f]" onClick={onOpenStatement}><FileBarChart2 className="ml-1.5 h-3.5 w-3.5" />ملف المشترك</Button> : null}</> : <Badge className="bg-[#F5B800]/10 text-[#F5B800]">{item.status === "active" ? "يعمل" : item.status === "maintenance" ? "صيانة" : item.status}</Badge>}{canEdit && <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:bg-[#F5B800]/10 hover:text-[#F5B800]" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></Button>}</div></div>;
}

function EditorTitle({ text, editing, onCancel }: { text: string; editing: boolean; onCancel: () => void }) { return <div className="flex items-center justify-between"><h2 className="font-bold text-white">{text}</h2>{editing && <Button size="sm" variant="ghost" className="text-slate-400" onClick={onCancel}>إلغاء</Button>}</div>; }
function SubmitButton({ text, pending }: { text: string; pending: boolean }) { return <Button disabled={pending} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Plus className="ml-2 h-4 w-4" />{text}</Button>; }
function Loading() { return <div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div>; }
function LoginPrompt({ title }: { title: string }) { return <div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-[#F5B800]/20 bg-[#111823] p-8 text-center shadow-panel"><UsersRound className="mx-auto h-8 w-8 text-[#F5B800]" /><h1 className="mt-5 text-xl font-extrabold text-white">سجّل الدخول إلى {title}</h1><p className="mt-3 leading-7 text-slate-400">يتطلب الوصول إلى بيانات الشبكة حساباً مصرحاً له.</p><Button onClick={() => startLogin()} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدخول</Button></div>; }
function ReadOnlyCard() { return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-7 text-center text-sm leading-7 text-slate-500">أنت في وضع القراءة فقط لهذه المحطة. تواصل مع مالك المحطة أو مديرها لتفعيل صلاحية التعديل.</CardContent></Card>; }
function EmptySetup() { return <div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center shadow-panel"><h1 className="text-xl font-extrabold text-white">أنشئ محطة أولاً</h1><p className="mt-3 text-slate-400">المشتركون والمولدات مرتبطون بمحطة توزيع محددة.</p></div>; }
