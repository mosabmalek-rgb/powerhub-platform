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
import { trpc } from "@/lib/trpc";
import {
  BellRing, Bolt, BriefcaseBusiness, ClipboardCheck, ChartNoAxesCombined, Fuel, Gauge,
  LayoutDashboard, LogOut, PanelLeft, ReceiptText, Sun, Moon, CircleCheck, X,
  Settings2, ShieldCheck, UsersRound, WalletCards, Building2, UserRound, Palette, Store, RadioTower,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { PowerHubLogo } from "./PowerHubLogo";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const menuGroups = [
  {
    label: "نظرة عامة",
    items: [{ icon: LayoutDashboard, label: "لوحة التحكم", path: "/workspace" }],
  },
  {
    label: "إدارة الشبكة",
    items: [
      { icon: UsersRound, label: "المشتركون", path: "/subscribers" },
      { icon: Store, label: "الأفرع", path: "/branches" },
      { icon: Bolt, label: "المحطات والمولدات", path: "/generators" },
      { icon: Gauge, label: "إضافة قراءة", path: "/readings" },
    ],
  },
  {
    label: "المالية",
    items: [
      { icon: ReceiptText, label: "الفواتير والتعرفات", path: "/invoices" },
      { icon: WalletCards, label: "التحصيلات", path: "/collections" },
      { icon: WalletCards, label: "حسابات الشركة", path: "/company-accounts" },
      { icon: Fuel, label: "المصروفات والربحية", path: "/expenses" },
      { icon: BriefcaseBusiness, label: "الموارد البشرية", path: "/human-resources" },
      { icon: ClipboardCheck, label: "الحضور والانصراف", path: "/attendance" },
      { icon: BriefcaseBusiness, label: "الرواتب والأجور", path: "/payroll" },
      { icon: ChartNoAxesCombined, label: "لوحة المالية", path: "/financial-dashboard" },
      { icon: ChartNoAxesCombined, label: "التسويات المالية", path: "/financial-settlements" },
      { icon: ChartNoAxesCombined, label: "التقارير", path: "/reports" },
    ],
  },
  {
    label: "الرقابة",
    items: [
      { icon: BellRing, label: "الإشعارات", path: "/notifications" },
      { icon: Palette, label: "بوابة المشتركين", path: "/portal-settings" },
      { icon: ShieldCheck, label: "السجل والتدقيق", path: "/audit" },
      { icon: RadioTower, label: "الميدان والمزامنة", path: "/mobile-sync" },
      { icon: Settings2, label: "الإعدادات", path: "/settings" },
    ],
  },
  {
    label: "الحساب",
    items: [      { icon: UserRound, label: "المعلومات وبيانات الدخول", path: "/profile" },
      { icon: UsersRound, label: "الحسابات الفرعية", path: "/staff" },
      { icon: BriefcaseBusiness, label: "الموارد البشرية", path: "/human-resources" }],
  },
];

const platformAdminGroup = {
  label: "إدارة المنصة",
  items: [{ icon: Building2, label: "أصحاب المولدات والاشتراكات", path: "/admin" }],
};

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
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
  const sidebarRef = useRef<HTMLDivElement>(null);
  const platformRoleLabel = ({ platform_owner: "مالك المنصة", platform_admin: "مشرف المنصة", finance_admin: "مشرف مالي" } as const)[user?.platformRole ?? "platform_admin"];
  const accountRoleLabel = user ? (user.role === "admin" ? platformRoleLabel : "مساحة تشغيل المولد") : "وضع معاينة آمن";
  const workspaceSites = trpc.powerhub.sites.list.useQuery(undefined, { enabled: Boolean(user && user.role !== "admin") });
  const primarySiteId = workspaceSites.data?.[0]?.id ?? 0;
  const smsAccess = trpc.powerhub.staff.myAccess.useQuery({ siteId: primarySiteId }, { enabled: Boolean(primarySiteId && user?.role !== "admin") });
  const smsApprovalQuery = trpc.powerhub.messaging.currentSmsPackageRequest.useQuery({ siteId: primarySiteId }, { enabled: Boolean(primarySiteId && smsAccess.data?.role === "owner"), refetchInterval: 15000 });
  const [dismissedSmsApprovalId, setDismissedSmsApprovalId] = useState<string | null>(() => localStorage.getItem("powerhub.sms-approval-notice-dismissed"));
  const branchPolicy = trpc.powerhub.sites.branchPolicy.useQuery({ siteId: primarySiteId }, { enabled: Boolean(primarySiteId && user?.role !== "admin") });
  const operationalGroups = menuGroups.map((group) => group.label === "إدارة الشبكة" ? { ...group, items: group.items.filter((item) => item.path !== "/branches" || branchPolicy.data?.isEnabled) } : group);
  const visibleMenuGroups = displayUser.role === "admin" ? [...operationalGroups, platformAdminGroup] : operationalGroups;
  const activeMenuItem = visibleMenuGroups.flatMap(group => group.items).find(item => item.path === location);
  const isMobile = useIsMobile();
  const approvedSmsRequest = smsApprovalQuery.data?.status === "approved" ? smsApprovalQuery.data : null;
  useEffect(() => { if (approvedSmsRequest && String(approvedSmsRequest.id) !== dismissedSmsApprovalId) toast.success(`تم اعتماد حزمة الرسائل وإضافة ${Number(approvedSmsRequest.approvedMessages ?? 0).toLocaleString("ar")} رسالة إلى رصيدك.`); }, [approvedSmsRequest, dismissedSmsApprovalId]);

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

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
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleSidebar}
                    className="h-8 w-8 flex items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-[#F5B800] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800] shrink-0"
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
            {visibleMenuGroups.map(group => (
              <div key={group.label} className="mb-3">
                {!isCollapsed && <p className="px-4 pb-2 pt-2 text-[10px] font-bold tracking-[0.13em] text-slate-500">{group.label}</p>}
                <SidebarMenu className="px-2 py-0">
                  {group.items.map(item => {
                    const isActive = location === item.path;
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => setLocation(item.path)}
                          tooltip={item.label}
                          className="h-10 rounded-lg font-medium text-slate-300 hover:bg-white/5 hover:text-white data-[active=true]:bg-[#F5B800] data-[active=true]:text-[#0D1117] data-[active=true]:font-bold"
                        >
                          <item.icon className="h-4 w-4" />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </div>
            ))}
          </SidebarContent>

          <SidebarFooter className="border-t border-white/8 p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button aria-label="فتح قائمة الحساب الشخصي" className="flex w-full items-center gap-3 rounded-lg px-1 py-1 text-right hover:bg-white/5 transition-colors group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800]">
                  <Avatar className="h-9 w-9 shrink-0 border border-[#F5B800]/30">
                    <AvatarFallback className="bg-[#F5B800]/10 text-xs font-bold text-[#F5B800]">
                      {displayUser.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-bold truncate leading-none text-white">
                      {displayUser.name || "-"}
                    </p>
                    <p className="text-xs text-slate-500 truncate mt-1.5">
                      {accountRoleLabel}
                    </p>
                  </div>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">فتح قائمة الحساب الشخصي</TooltipContent>
                </Tooltip>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48 border-white/10 bg-[#1b222c] text-white">
                <DropdownMenuItem
                  onClick={() => toggleTheme?.()}
                  className="cursor-pointer text-slate-200 focus:text-white"
                >
                  {theme === "dark" ? <Sun className="mr-2 h-4 w-4 text-[#F5B800]" /> : <Moon className="mr-2 h-4 w-4 text-[#F5B800]" />}
                  <span>{theme === "dark" ? "التبديل إلى الوضع النهاري" : "التبديل إلى الوضع الليلي"}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    if (user) logout();
                  }}
                  className="cursor-pointer text-rose-300 focus:text-rose-200"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>تسجيل الخروج</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
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
          <div className="flex h-14 items-center justify-between border-b border-white/8 bg-[#0D1117]/95 px-2 backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1">
                  <span className="tracking-tight text-foreground">
                    {activeMenuItem?.label ?? "لوحة التحكم"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        {approvedSmsRequest && String(approvedSmsRequest.id) !== dismissedSmsApprovalId ? <div className="sticky top-0 z-30 border-b border-emerald-300/25 bg-emerald-400/[.10] px-4 py-3 text-emerald-100 shadow-lg sm:px-6"><div className="mx-auto flex max-w-7xl items-center justify-between gap-3" dir="rtl"><div className="flex min-w-0 items-center gap-3"><CircleCheck className="h-5 w-5 shrink-0 text-emerald-300" /><p className="text-sm font-bold">تم اعتماد طلب شحن الرسائل وإضافة {Number(approvedSmsRequest.approvedMessages ?? 0).toLocaleString("ar")} رسالة إلى رصيد SMS.</p></div><button type="button" aria-label="إغلاق إشعار اعتماد الرسائل" onClick={() => { const id = String(approvedSmsRequest.id); setDismissedSmsApprovalId(id); localStorage.setItem("powerhub.sms-approval-notice-dismissed", id); }} className="rounded-lg p-1 text-emerald-200 transition hover:bg-emerald-300/15 hover:text-white"><X className="h-4 w-4" /></button></div></div> : null}
        <main className="ph-grid-bg min-h-screen flex-1 bg-[#0D1117] p-4 sm:p-6">{children}</main>
      </SidebarInset>
    </>
  );
}
