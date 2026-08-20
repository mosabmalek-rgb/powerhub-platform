import { PowerHubLogo } from "@/components/PowerHubLogo";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  BellRing,
  Building2,
  ChevronLeft,
  CircleDollarSign,
  FileBarChart,
  Gauge,
  LayoutDashboard,
  LogOut,
  PanelRightClose,
  PanelRightOpen,
  Settings2,
  ShieldCheck,
  Ticket,
  UsersRound,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

type PlatformAdminLayoutProps = {
  activeTab: string;
  onTabChange: (tab: string) => void;
  children: React.ReactNode;
};

type NavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  detail: string;
};

const navigationGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "نظرة عامة",
    items: [{ id: "overview", label: "لوحة التحكم الرئيسية", icon: LayoutDashboard, detail: "مؤشرات المنصة والتحليلات المركزية" }],
  },
  {
    label: "إدارة المنصة",
    items: [
      { id: "generators", label: "إدارة المولدات", icon: Zap, detail: "المولدات النشطة والموقوفة والمحظورة" },
      { id: "ownerSubscription", label: "اشتراك صاحب مولد", icon: Building2, detail: "إضافة المالك والباقات والتجديد" },
      { id: "users", label: "إدارة المستخدمين", icon: UsersRound, detail: "أصحاب المولدات والموظفون والصلاحيات" },
    ],
  },
  {
    label: "المالية والتحصيل",
    items: [
      { id: "finance", label: "المالية والتحصيل", icon: CircleDollarSign, detail: "الإيرادات والمتأخرات وطرق الدفع" },
      { id: "reports", label: "التقارير والإحصائيات", icon: FileBarChart, detail: "أداء المولدات والاستهلاك والنمو" },
      { id: "complaints", label: "الشكاوى", icon: Ticket, detail: "المتابعة والتعيين والردود" },
    ],
  },
  {
    label: "الرقابة والحماية",
    items: [
      { id: "notifications", label: "التنبيهات والإشعارات", icon: BellRing, detail: "التنبيهات وسجل الرسائل" },
      { id: "security", label: "الأمان والسجلات", icon: ShieldCheck, detail: "التدقيق والنسخ الاحتياطي والحماية" },
      { id: "settings", label: "إعدادات المنصة", icon: Settings2, detail: "الهوية والصفحة العامة والتكاملات" },
    ],
  },
];

function AdminNavButton({ item, active, collapsed, onClick }: { item: NavItem; active: boolean; collapsed: boolean; onClick: () => void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      className={`group flex w-full items-center gap-3 rounded-xl py-3 text-right transition ${collapsed ? "justify-center px-2" : "px-3"} ${active ? "bg-[#F5B800] text-[#0D1117] shadow-[0_8px_22px_rgba(245,184,0,.16)]" : "text-slate-300 hover:bg-white/[.055] hover:text-white"}`}
    >
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${active ? "bg-[#0D1117]/10" : "bg-white/[.055] text-[#F5B800] group-hover:bg-[#F5B800]/10"}`}><Icon className="h-4 w-4" /></span>
      <span className={collapsed ? "sr-only" : "min-w-0 flex-1"}><span className="block text-sm font-extrabold">{item.label}</span><span className={`mt-0.5 block truncate text-[11px] ${active ? "text-[#0D1117]/70" : "text-slate-500"}`}>{item.detail}</span></span>
      {!collapsed && <ChevronLeft className={`h-4 w-4 shrink-0 transition ${active ? "opacity-100" : "opacity-0 group-hover:opacity-70"}`} />}
    </button>
  );
}

export default function PlatformAdminLayout({ activeTab, onTabChange, children }: PlatformAdminLayoutProps) {
  const { user, logout } = useAuth();
  const initials = (user?.name ?? user?.email ?? "P").trim().slice(0, 1).toUpperCase();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className="min-h-screen bg-[#0B1018] text-white" dir="rtl">
      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#0D1117]/95 backdrop-blur-xl">
        <div className="flex h-[76px] items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <PowerHubLogo />
            <div className="hidden border-r border-white/10 pr-4 lg:block"><p className="text-[11px] font-bold text-[#F5B800]">PLATFORM ADMIN</p><p className="mt-0.5 text-sm font-extrabold text-white">مركز إدارة المنصة</p></div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="تنبيهات المنصة" onClick={() => onTabChange("notifications")} className="relative grid h-10 w-10 place-items-center rounded-xl border border-white/10 text-slate-300 transition hover:border-[#F5B800]/40 hover:bg-[#F5B800]/10 hover:text-[#F5B800]"><BellRing className="h-4 w-4" /><span className="absolute left-2 top-2 h-1.5 w-1.5 rounded-full bg-rose-400" /></button>
            <div className="hidden items-center gap-2 rounded-xl border border-white/10 bg-white/[.025] px-2.5 py-1.5 sm:flex"><span className="grid h-7 w-7 place-items-center rounded-lg bg-[#F5B800]/15 text-xs font-black text-[#F5B800]">{initials}</span><div className="max-w-32"><p className="truncate text-xs font-bold text-white">{user?.name ?? "مشرف المنصة"}</p><p className="text-[10px] text-slate-500">مشرف منصة</p></div></div>
            <button type="button" aria-label="تسجيل الخروج" onClick={() => void logout()} className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 text-slate-400 transition hover:border-rose-400/35 hover:bg-rose-400/10 hover:text-rose-300"><LogOut className="h-4 w-4" /></button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex min-h-[calc(100vh-76px)] max-w-[1800px]">
        <aside className={`hidden shrink-0 border-l border-white/8 bg-[#0D1117] transition-[width] duration-200 ease-out lg:block ${sidebarCollapsed ? "w-[86px]" : "w-[306px]"}`}>
          <div className={`sticky top-[76px] max-h-[calc(100vh-76px)] overflow-y-auto py-5 ${sidebarCollapsed ? "px-2" : "px-3"}`}>
            <div className={`mb-5 flex items-center rounded-2xl border border-[#F5B800]/15 bg-gradient-to-bl from-[#F5B800]/10 to-transparent ${sidebarCollapsed ? "justify-center p-3" : "justify-between p-4"}`}><div className="flex items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#F5B800] text-[#0D1117]"><Gauge className="h-5 w-5" /></span>{!sidebarCollapsed && <div><p className="text-sm font-extrabold text-white">إدارة موحّدة</p><p className="mt-1 text-xs leading-5 text-slate-500">متابعة المنصة عبر جميع المستأجرين</p></div>}</div>{!sidebarCollapsed && <button type="button" aria-label="تصغير القائمة الجانبية" onClick={() => setSidebarCollapsed(true)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-white/8 hover:text-[#F5B800]"><PanelRightClose className="h-4 w-4" /></button>}</div>
            {sidebarCollapsed && <button type="button" aria-label="توسيع القائمة الجانبية" onClick={() => setSidebarCollapsed(false)} className="mb-4 grid h-10 w-full place-items-center rounded-xl border border-white/10 text-slate-400 transition hover:border-[#F5B800]/40 hover:bg-[#F5B800]/10 hover:text-[#F5B800]"><PanelRightOpen className="h-4 w-4" /></button>}
            <nav aria-label="تنقل مركز إدارة المنصة" className="space-y-5">
              {navigationGroups.map((group) => <section key={group.label}><p className={sidebarCollapsed ? "sr-only" : "mb-2 px-3 text-[10px] font-black tracking-[.16em] text-slate-500"}>{group.label}</p><div className="space-y-1">{group.items.map((item) => <AdminNavButton key={item.id} item={item} active={activeTab === item.id} collapsed={sidebarCollapsed} onClick={() => onTabChange(item.id)} />)}</div></section>)}
            </nav>
            {!sidebarCollapsed && <div className="mt-6 rounded-2xl border border-white/8 bg-white/[.02] p-3 text-xs leading-6 text-slate-500">تعمل صلاحيات المشرف ضمن سياسات المنصة المركزية، مع بقاء بيانات كل مولد معزولة عن غيره.</div>}
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="border-b border-white/8 bg-[#101722] lg:hidden"><div className="flex gap-2 overflow-x-auto px-4 py-3">{navigationGroups.flatMap((group) => group.items).map((item) => <button type="button" key={item.id} onClick={() => onTabChange(item.id)} className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ${activeTab === item.id ? "bg-[#F5B800] text-[#0D1117]" : "border border-white/10 bg-white/[.03] text-slate-300"}`}>{item.label}</button>)}</div></div>
          <div className="mx-auto max-w-[1480px] p-4 sm:p-6 xl:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
