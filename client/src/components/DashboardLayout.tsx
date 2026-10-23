import { useAuth } from "@/_core/hooks/useAuth";
import { useTheme } from "@/contexts/ThemeContext";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/useMobile";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import {
  BellRing, Bolt, BriefcaseBusiness, ClipboardCheck, ChartNoAxesCombined, Fuel, Gauge, Boxes,
  LayoutDashboard, LogOut, PanelLeft, ReceiptText, Sun, Moon, CircleCheck, X, MessageSquareText,
  Settings2, ShieldCheck, UsersRound, WalletCards, Building2, UserRound, Palette, Store, RadioTower, Zap, CloudOff, Bot,
} from "lucide-react";
import { CSSProperties, startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { preloadRoute, preloadWorkspaceRoutes } from "@/lib/route-preload";
import type { PowerCapability, PowerRole } from "@shared/powerhub-rbac";
import { tenantMenuRouteAllowed } from "@/lib/tenant-menu-access";
import { PowerHubLogo } from "./PowerHubLogo";
import { NotificationCenter } from "@/components/NotificationCenter";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const menuGroups = [
  {
    label: "نظرة عامة",
    items: [
      { icon: LayoutDashboard, label: "لوحة التحكم", path: "/workspace" },
      { icon: Zap, label: "الإجراءات السريعة", path: "/quick-actions" },
    ],
  },
  {
    label: "التشغيل",
    items: [
      { icon: UsersRound, label: "المشتركون", path: "/subscribers" },
      { icon: Store, label: "الأفرع", path: "/branches" },
      { icon: Gauge, label: "إضافة قراءة", path: "/readings" },
    ],
  },
  {
    label: "المالية",
    items: [
      { icon: ReceiptText, label: "الفواتير", path: "/invoices" },
      { icon: WalletCards, label: "التحصيلات", path: "/collections" },
      { icon: WalletCards, label: "حسابات الشركة", path: "/company-accounts" },
      { icon: Fuel, label: "المصروفات والربحية", path: "/expenses" },
      { icon: Boxes, label: "التشغيل والمشتريات", path: "/inventory" },
      { icon: ChartNoAxesCombined, label: "لوحة المالية", path: "/financial-dashboard" },
      { icon: ChartNoAxesCombined, label: "التسويات المالية", path: "/financial-settlements" },
      { icon: ClipboardCheck, label: "توثيق الدفع", path: "/payment-documentation" },
      { icon: ClipboardCheck, label: "مراجعة توثيق الدفع", path: "/payment-documentation/review", capability: "approvePaymentDocumentation" as PowerCapability },
    ],
  },
  {
    label: "إدارة الفريق",
    items: [
      { icon: BriefcaseBusiness, label: "الموارد البشرية", path: "/human-resources" },
      { icon: UsersRound, label: "الحسابات الفرعية", path: "/staff" },
      { icon: ClipboardCheck, label: "الحضور والانصراف", path: "/attendance" },
      { icon: BriefcaseBusiness, label: "الرواتب والأجور", path: "/payroll" },
    ],
  },
  {
    label: "التقارير",
    items: [
      { icon: ChartNoAxesCombined, label: "التقارير", path: "/reports" },
    ],
  },
  {
    label: "المراسلات والدعم",
    items: [
      { icon: MessageSquareText, label: "مركز الرسائل", path: "/notifications" },
      { icon: BellRing, label: "أخبار وإعلانات المنصة", path: "/announcements" },
      { icon: RadioTower, label: "الدردشة والدعم", path: "/support-chat" },
      { icon: Bot, label: "مساعد PowerHub الذكي", path: "/ai-support" },
    ],
  },
  {
    label: "الميدان والرقابة",
    items: [
      { icon: RadioTower, label: "الميدان والمزامنة", path: "/mobile-sync" },
      { icon: CloudOff, label: "مسودات دون اتصال", path: "/offline-sync" },
      { icon: ShieldCheck, label: "السجل والتدقيق", path: "/audit" },
    ],
  },
  {
    label: "الإعدادات والتخصيص",
    items: [
      { icon: Palette, label: "بوابة المشتركين", path: "/portal-settings" },
      { icon: Settings2, label: "الإعدادات", path: "/settings" },
    ],
  },
  {
    label: "الحساب",
    items: [
      { icon: UserRound, label: "المعلومات وبيانات الدخول", path: "/profile" },
    ],
  },
];

const platformAdminGroup = {
  label: "إدارة المنصة",
  items: [{ icon: Building2, label: "أصحاب المولدات والاشتراكات", path: "/admin" }],
};

const SIDEBAR_WIDTH_KEY = "sidebar-width-v2";
const LEGACY_SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 238;
const MIN_WIDTH = 170;
const MAX_WIDTH = 408;
const TENANT_ACCESS_CACHE_PREFIX = "powerhub.tenant-access.v1";

type TenantAccessSnapshot = {
  role: PowerRole;
  permissions: PowerCapability[];
  tenantId: number;
  usesPermissionOverride: boolean;
};

type WorkspaceSiteSnapshot = {
  id: number;
  tenantId: number;
  tenantName: string;
  name: string;
  code: string;
  city: string | null;
  address: string | null;
  status: "active" | "inactive" | "archived";
  anomalyAlertPercent: number;
  invoiceDueDays: number;
  invoiceDueHours: number;
  createdAt: Date;
};

const WORKSPACE_SITES_CACHE_PREFIX = "powerhub.workspace-sites.v1";

function readCachedWorkspaceSites(userId: number | undefined): WorkspaceSiteSnapshot[] | null {
  if (!userId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(`${WORKSPACE_SITES_CACHE_PREFIX}:${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Array<Partial<Omit<WorkspaceSiteSnapshot, "createdAt">> & { createdAt?: string }>;
    if (!Array.isArray(parsed)) return null;
    const sites = parsed.flatMap((site) => {
      if (
        typeof site.id !== "number" ||
        typeof site.tenantId !== "number" ||
        typeof site.tenantName !== "string" ||
        typeof site.name !== "string" ||
        typeof site.code !== "string" ||
        !["active", "inactive", "archived"].includes(String(site.status)) ||
        typeof site.anomalyAlertPercent !== "number" ||
        typeof site.invoiceDueDays !== "number" ||
        typeof site.createdAt !== "string"
      ) return [];
      const createdAt = new Date(site.createdAt);
      if (Number.isNaN(createdAt.getTime())) return [];
      return [{
        id: site.id,
        tenantId: site.tenantId,
        tenantName: site.tenantName,
        name: site.name,
        code: site.code,
        city: site.city ?? null,
        address: site.address ?? null,
        status: site.status as WorkspaceSiteSnapshot["status"],
        anomalyAlertPercent: site.anomalyAlertPercent,
        invoiceDueDays: site.invoiceDueDays,
        invoiceDueHours: typeof site.invoiceDueHours === "number" ? site.invoiceDueHours : site.invoiceDueDays * 24,
        createdAt,
      }];
    });
    return sites.length ? sites : null;
  } catch {
    return null;
  }
}

function writeCachedWorkspaceSites(userId: number | undefined, sites: WorkspaceSiteSnapshot[] | undefined) {
  if (!userId || !sites?.length || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      `${WORKSPACE_SITES_CACHE_PREFIX}:${userId}`,
      JSON.stringify(sites),
    );
  } catch {
    // Ignore unavailable browser storage.
  }
}

function readCachedTenantAccess(userId: number | undefined, siteId: number) {
  if (!userId || !siteId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(`${TENANT_ACCESS_CACHE_PREFIX}:${userId}:${siteId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TenantAccessSnapshot>;
    if (
      (parsed.role === "owner" ||
        parsed.role === "manager" ||
        parsed.role === "accountant" ||
        parsed.role === "collector" ||
        parsed.role === "technician" ||
        parsed.role === "viewer") &&
      Array.isArray(parsed.permissions) &&
      typeof parsed.tenantId === "number" &&
      typeof parsed.usesPermissionOverride === "boolean"
    ) {
      return parsed as TenantAccessSnapshot;
    }
  } catch {
    // Ignore malformed or unavailable browser storage.
  }
  return null;
}

function writeCachedTenantAccess(userId: number | undefined, siteId: number, access: TenantAccessSnapshot) {
  if (!userId || !siteId || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${TENANT_ACCESS_CACHE_PREFIX}:${userId}:${siteId}`, JSON.stringify(access));
  } catch {
    // Ignore unavailable browser storage.
  }
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (saved) {
      const parsed = Number.parseInt(saved, 10);
      return Number.isFinite(parsed) ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parsed)) : DEFAULT_WIDTH;
    }

    // Migrate each user's previously saved width once, keeping the existing font size and reducing width by ~15%.
    const legacy = localStorage.getItem(LEGACY_SIDEBAR_WIDTH_KEY);
    if (legacy) {
      const parsed = Number.parseInt(legacy, 10);
      if (Number.isFinite(parsed)) return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(parsed * 0.85)));
    }
    return DEFAULT_WIDTH;
  });
  const { user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const displayUser = user ?? { name: "معاينة PowerHub", email: "واجهة تصميمية", role: "user" as const };
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarToggleTooltipOpen, setSidebarToggleTooltipOpen] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const platformRoleLabel = ({ platform_owner: "مالك المنصة", platform_admin: "مشرف المنصة", finance_admin: "مشرف مالي", platform_support: "موظف دعم" } as const)[user?.platformRole ?? "platform_admin"];
  const accountRoleLabel = user ? (user.role === "admin" ? platformRoleLabel : "مساحة تشغيل المولد") : "وضع معاينة آمن";
  const cachedWorkspaceSites = useMemo(() => readCachedWorkspaceSites(user?.id), [user?.id]);
  const workspaceSites = trpc.powerhub.sites.list.useQuery(undefined, {
    enabled: Boolean(user && user.role !== "admin"),
    initialData: cachedWorkspaceSites ?? undefined,
  });
  const tenantDisplayName = workspaceSites.data?.[0]?.tenantName ?? null;

  useEffect(() => {
    if (!user || user.role === "admin" || !workspaceSites.data) return;
    writeCachedWorkspaceSites(user.id, workspaceSites.data);
  }, [user, workspaceSites.data]);
  const primarySiteId = workspaceSites.data?.[0]?.id ?? 0;
  const { branchId: activeSiteId } = useBranchFilter(workspaceSites.data);
  const resolvedActiveSiteId = activeSiteId && workspaceSites.data?.some((site) => site.id === activeSiteId)
    ? activeSiteId
    : primarySiteId;

  // Keep the last server-confirmed access snapshot for this browser session.
  // On a hard refresh this lets the menu render immediately while the server
  // revalidates the current membership/subscription in the background.
  const cachedActiveAccess = useMemo(
    () => readCachedTenantAccess(user?.id, resolvedActiveSiteId),
    [user?.id, resolvedActiveSiteId],
  );

  const activeAccess = trpc.powerhub.staff.myAccess.useQuery({ siteId: resolvedActiveSiteId ?? 0 }, {
    enabled: Boolean(resolvedActiveSiteId && user?.role !== "admin"),
    initialData: cachedActiveAccess ?? undefined,
    // The cached value is only a visual bootstrap. The live response remains the
    // authority and is always fetched on mount/focus/reconnect.
    refetchInterval: 15000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  useEffect(() => {
    if (!activeAccess.data || !resolvedActiveSiteId || user?.role === "admin" || activeAccess.isError) return;
    writeCachedTenantAccess(user?.id, resolvedActiveSiteId, activeAccess.data);
  }, [activeAccess.data, activeAccess.isError, resolvedActiveSiteId, user?.id, user?.role]);

  // Never use cached access after the live server check has explicitly failed.
  // This prevents a stale subscription/permission snapshot from surviving a
  // confirmed 401/403 while still eliminating the refresh-time menu flash.
  const activeTenantAccess = activeAccess.isError
    ? null
    : activeAccess.data ?? cachedActiveAccess;
  const hasActiveTenantAccess = Boolean(activeTenantAccess?.role);

  useEffect(() => {
    if (user?.role === "admin" || !hasActiveTenantAccess) return;
    preloadWorkspaceRoutes();
  }, [user?.role, hasActiveTenantAccess]);
  useEffect(() => {
    if (!resolvedActiveSiteId || user?.role === "admin" || hasActiveTenantAccess) return;

    // When the last access check failed because the subscription was expired,
    // retry explicitly until the renewed subscription becomes visible. This
    // avoids depending solely on React Query's interval scheduling for an
    // errored query and stops immediately after access is restored.
    const retryId = window.setInterval(() => {
      void activeAccess.refetch();
    }, 5000);

    return () => window.clearInterval(retryId);
  }, [resolvedActiveSiteId, user?.role, hasActiveTenantAccess, activeAccess.refetch]);
  const smsAccess = trpc.powerhub.staff.myAccess.useQuery({ siteId: primarySiteId }, { enabled: Boolean(primarySiteId && user?.role !== "admin") });
  const smsApprovalQuery = trpc.powerhub.messaging.currentSmsPackageRequest.useQuery({ siteId: primarySiteId }, { enabled: Boolean(primarySiteId && smsAccess.data?.role === "owner"), refetchInterval: 15000 });
  const [dismissedSmsApprovalId, setDismissedSmsApprovalId] = useState<string | null>(() => localStorage.getItem("powerhub.sms-approval-notice-dismissed"));
  const branchPolicy = trpc.powerhub.sites.branchPolicy.useQuery({ siteId: primarySiteId }, { enabled: Boolean(primarySiteId && user?.role !== "admin") });
  const paymentDocumentationAccess = trpc.powerhub.paymentDocumentation.access.useQuery({ siteId: primarySiteId }, { enabled: Boolean(primarySiteId && user?.role !== "admin") });
  const operationalGroups = menuGroups.map((group) => group.label === "التشغيل" ? { ...group, items: group.items.filter((item) => item.path !== "/branches" || branchPolicy.data?.isEnabled) } : group);
  const canSeePlatformAdmin = displayUser.role === "admin" && ["platform_owner", "platform_admin"].includes(displayUser.platformRole ?? "");
  const visibleMenuGroups = canSeePlatformAdmin ? [...operationalGroups, platformAdminGroup] : operationalGroups;
  const permissionAwareGroups = visibleMenuGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (displayUser.role === "admin") return true;
      if (item.path === "/payment-documentation") return Boolean(paymentDocumentationAccess.data?.allowed);
      if (!hasActiveTenantAccess) return item.path === "/workspace" || item.path === "/profile";
      if (!activeTenantAccess) return item.path === "/workspace" || item.path === "/profile";
      return tenantMenuRouteAllowed(item.path, activeTenantAccess.role, activeTenantAccess.permissions, activeTenantAccess.usesPermissionOverride);
    }),
  })).filter((group) => group.items.length > 0);
  const activeMenuItem = permissionAwareGroups.flatMap(group => group.items).find(item => item.path === location);
  const isMobile = useIsMobile();
  const approvedSmsRequest = smsApprovalQuery.data?.status === "approved" ? smsApprovalQuery.data : null;
  const announcementsQuery = trpc.platformAnnouncements.inbox.unreadCount.useQuery(undefined, { enabled: Boolean(user), staleTime: 30000, refetchOnWindowFocus: true });
  const unreadAnnouncements = Number(announcementsQuery.data ?? 0);



  useEffect(() => { if (approvedSmsRequest && String(approvedSmsRequest.id) !== dismissedSmsApprovalId) toast.success(`تم اعتماد حزمة الرسائل وإضافة ${Number(approvedSmsRequest.approvedMessages ?? 0).toLocaleString("ar")} رسالة إلى رصيدك.`); }, [approvedSmsRequest, dismissedSmsApprovalId]);

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

  useEffect(() => {
    const closeTooltip = () => setSidebarToggleTooltipOpen(false);

    document.addEventListener("visibilitychange", closeTooltip);
    window.addEventListener("blur", closeTooltip);

    return () => {
      document.removeEventListener("visibilitychange", closeTooltip);
      window.removeEventListener("blur", closeTooltip);
    };
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          side="right"
          collapsible="icon"
          className="border-l border-white/8 bg-[#0d1117] text-white"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-[88px] justify-center border-b border-white/8">
            <div className="flex items-center gap-3 px-2 transition-all w-full">
              <Tooltip open={sidebarToggleTooltipOpen} onOpenChange={setSidebarToggleTooltipOpen}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => {
                      setSidebarToggleTooltipOpen(false);
                      toggleSidebar();
                    }}
                    className="h-8 w-8 flex items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-[#ffbf00] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800] shrink-0"
                    aria-label={isCollapsed ? "توسيع القائمة الجانبية" : "طي القائمة الجانبية"}
                  >
                    <PanelLeft className="h-4 w-4 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">{isCollapsed ? "توسيع القائمة الجانبية" : "طي القائمة الجانبية"}</TooltipContent>
              </Tooltip>
              {!isCollapsed ? (
                <div className="flex items-center gap-2 min-w-0">
                  <PowerHubLogo className="scale-90 origin-right" />
                </div>
              ) : null}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0 py-3">
            {permissionAwareGroups.map(group => (
              <div key={group.label} className="mb-3">
                {!isCollapsed && <p className="px-4 pb-2 pt-2 text-[10px] font-bold tracking-[0.13em] text-slate-500">{group.label}</p>}
                <SidebarMenu className="px-2 py-0">
                  {group.items.map(item => {
                    const isActive = location === item.path;
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          tooltip={item.label}
                          className="h-10 rounded-lg font-medium text-slate-300 hover:bg-white/5 hover:text-white data-[active=true]:bg-[#F5B800] data-[active=true]:text-[#0D1117] data-[active=true]:font-bold"
                        >
                          <a
                            href={item.path}
                            aria-current={isActive ? "page" : undefined}
                            onMouseEnter={() => preloadRoute(item.path)}
                            onFocus={() => preloadRoute(item.path)}
                            onClick={(event) => {
                              if (
                                event.defaultPrevented ||
                                event.button !== 0 ||
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey
                              ) {
                                return;
                              }
                              event.preventDefault();
                              // Reset only the page viewport when switching sidebar pages.
                              // Do not change the sidebar's own scroll position: SidebarContent
                              // persists that independently across route changes and refreshes.
                              if (location !== item.path) {
                                window.scrollTo({ top: 0, left: 0, behavior: "auto" });
                              }
                              startTransition(() => setLocation(item.path));
                            }}
                          >
                            <item.icon className="h-4 w-4" />
                            <span>{item.label}</span>{item.path === "/announcements" && unreadAnnouncements > 0 ? <span className="mr-auto min-w-4 rounded-full bg-rose-500 px-1 text-center text-[9px] font-extrabold leading-4 text-white">{unreadAnnouncements > 99 ? "99+" : unreadAnnouncements}</span> : null}
                          </a>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </div>
            ))}
                    </SidebarContent>

          <SidebarFooter className="border-t border-white/8 p-3">
            <div className={isCollapsed ? "flex flex-col-reverse items-center gap-1.5" : "flex items-center gap-2"}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="فتح قائمة الحساب الشخصي"
                    title="فتح قائمة الحساب الشخصي"
                    className={isCollapsed ? "flex h-9 w-9 flex-none items-center justify-center rounded-lg p-0 text-right transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800]" : "flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1 text-right transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800]"}
                  >
                    <Avatar className="h-9 w-9 shrink-0 border border-[#F5B800]/30">
                      <AvatarFallback className="bg-[#F5B800]/10 text-xs font-bold text-[#ffbf00]">
                        {displayUser.name?.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                      <p className="truncate text-sm font-bold leading-none text-white">
                        {displayUser.name || "-"}
                      </p>
                      <p className="mt-1.5 truncate text-xs text-slate-500">
                        {accountRoleLabel}
                      </p>
                    </div>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48 border-white/10 bg-[#1b222c] text-white">
                  <DropdownMenuItem
                    onClick={() => toggleTheme?.()}
                    className="cursor-pointer text-slate-200 focus:text-white"
                  >
                    {theme === "dark" ? <Sun className="mr-2 h-4 w-4 text-[#ffbf00]" /> : <Moon className="mr-2 h-4 w-4 text-[#ffbf00]" />}
                    <span>{theme === "dark" ? "التبديل إلى الوضع النهاري" : "التبديل إلى الوضع الليلي"}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      if (user) void logout();
                    }}
                    disabled={!user}
                    aria-label="تسجيل الخروج"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-rose-300 transition-colors hover:bg-rose-500/10 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">تسجيل الخروج</TooltipContent>
              </Tooltip>
            </div>
          </SidebarFooter>      </Sidebar>
        <div
          className={`absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-[#F5B800]/40 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => {
            if (isCollapsed) return;
            setIsResizing(true);
          }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        {isMobile && (
          <div className="flex h-16 items-center justify-between border-b border-black/20 bg-[#d6a204] px-2 backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  {tenantDisplayName ? <span className="truncate text-base font-extrabold tracking-tight text-[#111827]" style={{ WebkitTextStroke: "0px transparent", textShadow: "none" }}>{tenantDisplayName}</span> : null}
                  <span className="truncate text-sm font-semibold tracking-tight text-[#292524]">
                    {activeMenuItem?.label ?? "لوحة التحكم"}
                  </span>
                </div>
              </div>
            </div>
            {user?.id ? <NotificationCenter userId={user.id} enabled={location !== "/notifications-center"} /> : null}

            <button
              type="button"
              onClick={() => {
                if (user) void logout();
              }}
              disabled={!user}
              aria-label="تسجيل الخروج"
              className="flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-bold text-rose-300 hover:bg-rose-500/10 hover:text-rose-200 disabled:opacity-40"
            >
              <LogOut className="h-4 w-4" />
              <span>خروج</span>
            </button>
          </div>
        )}
        {!isMobile ? (
          <header className="sticky top-0 z-30 min-h-16 border-b border-black/20 bg-[#d6a204] px-3 py-3 backdrop-blur sm:px-6 sm:py-3" dir="rtl">
            <div className="flex w-full min-w-0 flex-row items-center justify-between gap-3">
              <div className="min-w-0 flex-1 text-right">
                <div className="truncate text-xl font-extrabold leading-tight tracking-tight text-[#111827]" style={{ WebkitTextStroke: "0px transparent", textShadow: "none" }}>{user?.role === "admin" ? "إدارة المنصة" : tenantDisplayName ?? "مساحة المولد"}</div>
                <div className="mt-1 truncate text-sm font-semibold tracking-tight text-[#292524]">{activeMenuItem?.label ?? "لوحة التحكم"}</div>
              </div>
              <div className="flex w-auto max-w-[42%] min-w-0 shrink-0 items-center gap-3 text-left text-xs font-semibold text-[#1f2937]">
                <span className="max-w-full min-w-0 truncate whitespace-nowrap">{displayUser.name || ""}</span>
                {user?.id ? <NotificationCenter userId={user.id} enabled={location !== "/notifications-center"} /> : null}
              </div>
            </div>
          </header>
        ) : null}
        {approvedSmsRequest && String(approvedSmsRequest.id) !== dismissedSmsApprovalId ? <div className="sticky top-0 z-30 border-b border-emerald-300/25 bg-emerald-400/[.10] px-4 py-3 text-emerald-100 shadow-lg sm:px-6"><div className="mx-auto flex max-w-7xl items-center justify-between gap-3" dir="rtl"><div className="flex min-w-0 items-center gap-3"><CircleCheck className="h-5 w-5 shrink-0 text-emerald-300" /><p className="text-sm font-bold">تم اعتماد طلب شحن الرسائل وإضافة {Number(approvedSmsRequest.approvedMessages ?? 0).toLocaleString("ar")} رسالة إلى رصيد SMS.</p></div><button type="button" aria-label="إغلاق إشعار اعتماد الرسائل" onClick={() => { const id = String(approvedSmsRequest.id); setDismissedSmsApprovalId(id); localStorage.setItem("powerhub.sms-approval-notice-dismissed", id); }} className="rounded-lg p-1 text-emerald-200 transition hover:bg-emerald-300/15 hover:text-white"><X className="h-4 w-4" /></button></div></div> : null}
        <main className="ph-grid-bg min-h-screen min-w-0 flex-1 overflow-x-clip bg-[#0D1117] p-4 sm:p-6">{children}</main>
      </SidebarInset>
    </>
  );
}
