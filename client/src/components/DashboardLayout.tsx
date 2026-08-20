import { useAuth } from "@/_core/hooks/useAuth";
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
import {
  BellRing, Bolt, ChartNoAxesCombined, Fuel, Gauge,
  LayoutDashboard, LogOut, MapPinned, PanelLeft, ReceiptText,
  Settings2, ShieldCheck, UsersRound, WalletCards, Building2,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { PowerHubLogo } from "./PowerHubLogo";

const menuGroups = [
  {
    label: "نظرة عامة",
    items: [{ icon: LayoutDashboard, label: "لوحة التحكم", path: "/" }],
  },
  {
    label: "إدارة الشبكة",
    items: [
      { icon: UsersRound, label: "المشتركون", path: "/subscribers" },
      { icon: Bolt, label: "المحطات والمولدات", path: "/generators" },
      { icon: Gauge, label: "العدادات والقراءات", path: "/readings" },
      { icon: MapPinned, label: "خريطة الشبكة", path: "/map" },
    ],
  },
  {
    label: "المالية",
    items: [
      { icon: ReceiptText, label: "الفواتير والتعرفات", path: "/invoices" },
      { icon: WalletCards, label: "التحصيلات", path: "/collections" },
      { icon: Fuel, label: "المصروفات والربحية", path: "/expenses" },
      { icon: ChartNoAxesCombined, label: "التقارير", path: "/reports" },
    ],
  },
  {
    label: "الرقابة",
    items: [
      { icon: BellRing, label: "الإشعارات", path: "/notifications" },
      { icon: ShieldCheck, label: "السجل والتدقيق", path: "/audit" },
      { icon: Settings2, label: "الإعدادات", path: "/settings" },
    ],
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
  const displayUser = user ?? { name: "معاينة PowerHub", email: "واجهة تصميمية", role: "user" as const };
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const platformRoleLabel = ({ platform_owner: "مالك المنصة", platform_admin: "مشرف المنصة", finance_admin: "مشرف مالي" } as const)[user?.platformRole ?? "platform_admin"];
  const accountRoleLabel = user ? (user.role === "admin" ? platformRoleLabel : "مساحة تشغيل المولد") : "وضع معاينة آمن";
  const visibleMenuGroups = displayUser.role === "admin" ? [...menuGroups, platformAdminGroup] : menuGroups;
  const activeMenuItem = visibleMenuGroups.flatMap(group => group.items).find(item => item.path === location);
  const isMobile = useIsMobile();

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
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-[#F5B800] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800] shrink-0"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4 text-muted-foreground" />
              </button>
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
                <button className="flex w-full items-center gap-3 rounded-lg px-1 py-1 text-right hover:bg-white/5 transition-colors group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800]">
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
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48 border-white/10 bg-[#1b222c] text-white">
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
        <main className="ph-grid-bg min-h-screen flex-1 bg-[#0D1117] p-4 sm:p-6">{children}</main>
      </SidebarInset>
    </>
  );
}
