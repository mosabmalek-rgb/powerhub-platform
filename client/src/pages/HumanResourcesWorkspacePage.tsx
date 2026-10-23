import DashboardLayout from "@/components/DashboardLayout";
import HumanResourcesPage from "@/pages/HumanResourcesPage";
import AttendancePage from "@/pages/AttendancePage";
import PayrollPage from "@/pages/PayrollPage";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { can } from "@shared/powerhub-rbac";
import { BriefcaseBusiness, CalendarCheck2, CircleDollarSign } from "lucide-react";

export default function HumanResourcesWorkspacePage() {
  const sites = trpc.powerhub.sites.list.useQuery(undefined);
  const { branchId: siteId } = useBranchFilter(sites.data);
  const access = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId) });
  const role = access.data?.role;
  const permissions = access.data?.permissions;
  const canViewPeople = role === "owner" || role === "accountant" || can(role, "manageTeam", permissions);
  const canViewAttendance = (role === "owner" || role === "accountant") && can(role, "managePayroll", permissions);
  const canViewPayroll = (role === "owner" || role === "accountant") && can(role, "managePayroll", permissions);
  const defaultTab = canViewPeople ? "employees" : canViewAttendance ? "attendance" : "payroll";
  return <DashboardLayout><div dir="rtl" className="space-y-5">
    <header className="rounded-2xl border border-white/10 bg-[#111823] p-5">
      <div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><BriefcaseBusiness className="h-4 w-4" />إدارة الفريق</div>
      <h1 className="mt-2 text-2xl font-extrabold text-white">الموارد البشرية وشؤون الموظفين</h1>
      <p className="mt-1 text-sm text-slate-400">مساحة موحدة لملفات الموظفين والحضور والانصراف وكشوف الرواتب، مع فصل الصلاحيات والإجراءات المالية.</p>
    </header>
    <Tabs defaultValue={defaultTab} dir="rtl" className="space-y-4">
      <TabsList className="flex h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
        {canViewPeople ? <TabsTrigger value="employees" className="gap-2 border border-white/10 data-[state=active]:border-[#F5B800] data-[state=active]:bg-[#F5B800]/10"><BriefcaseBusiness className="h-4 w-4" />الموارد البشرية</TabsTrigger> : null}
        {canViewAttendance ? <TabsTrigger value="attendance" className="gap-2 border border-white/10 data-[state=active]:border-[#F5B800] data-[state=active]:bg-[#F5B800]/10"><CalendarCheck2 className="h-4 w-4" />الحضور والانصراف</TabsTrigger> : null}
        {canViewPayroll ? <TabsTrigger value="payroll" className="gap-2 border border-white/10 data-[state=active]:border-[#F5B800] data-[state=active]:bg-[#F5B800]/10"><CircleDollarSign className="h-4 w-4" />الرواتب والأجور</TabsTrigger> : null}
      </TabsList>
      {canViewPeople ? <TabsContent value="employees" className="mt-0"><HumanResourcesPage embedded /></TabsContent> : null}
      {canViewAttendance ? <TabsContent value="attendance" className="mt-0"><AttendancePage embedded /></TabsContent> : null}
      {canViewPayroll ? <TabsContent value="payroll" className="mt-0"><PayrollPage embedded /></TabsContent> : null}
    </Tabs>
  </div></DashboardLayout>;
}
