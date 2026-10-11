import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { startLogin } from "@/const";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { ClipboardCheck, Loader2, ShieldCheck } from "lucide-react";

const actionNames: Record<string, string> = {
  platform_admin_create_generator_owner_subscription: "إنشاء اشتراك صاحب مولد من إدارة المنصة",
  platform_admin_update_subscription: "تحديث اشتراك من إدارة المنصة",
  renew_subscription_with_addons: "تجديد الاشتراك مع الإضافات",
  configure: "تغيير الإعدادات",
  automatic_opening_baseline_approval: "اعتماد القراءة الافتتاحية تلقائياً",
  bulk_import: "استيراد جماعي",
  bulk_import_create: "إنشاء من استيراد جماعي",
  create_with_opening_reading: "إنشاء مشترك مع قراءة افتتاحية",
  delete: "حذف",
  deposit: "إيداع",
  enable: "تفعيل",
  grant_addon: "منح إضافة",
  status_change: "تغيير الحالة",
  sync_cycle: "مزامنة دورة",
  sync_error: "خطأ في المزامنة",
  update_payment_documentation_visibility: "تحديث ظهور توثيق الدفع",
  update_portal_logo: "تحديث شعار بوابة المشترك",
  update_report_branding: "تحديث هوية التقارير",
  create_share_link: "إنشاء رابط مشاركة",
  update_opening_balance: "تحديث الرصيد الافتتاحي",
  update_phone: "تحديث رقم الجوال",
  update_sites: "تحديث الفروع المرتبطة",
  mobile_create: "إنشاء من التطبيق الميداني",
  automatic_invoice_issue: "إصدار فاتورة تلقائياً",
  configure_reading_cycle: "تعديل دورة القراءة والفوترة",
  create: "إنشاء",
  update: "تحديث",
  approve: "اعتماد",
  issue: "إصدار",
  assign_role: "تعيين دور",
  upsert: "حفظ إعداد",
  send: "إرسال",
  resend: "إعادة إرسال",
  retry: "إعادة محاولة",
  admin_set_tenant_status: "تحديث حالة مساحة المولد",
  platform_admin_update_generator_status: "تحديث حالة المولد",
  owner_usage_alert_sent: "إرسال تنبيه استخدام",
  company_account_visibility: "تحديث ظهور الحساب في توثيق الدفع",
};
const entityNames: Record<string, string> = {
  chat_conversation: "محادثة دعم",
  financial_settlement: "تسوية مالية",
  mobile_sync_event: "حدث مزامنة ميدانية",
  site_portal_settings: "إعدادات بوابة المشترك",
  subscriber_import: "استيراد مشتركين",
  tenant_addon_request: "طلب إضافة للاشتراك",
  tenant_feature_entitlement: "صلاحية ميزة",
  tenant_owner_profile: "ملف صاحب المولد",
  tenant_subscription: "اشتراك صاحب المولد",
  reading_cycle: "دورة القراءة والفوترة",
  site: "محطة",
  tenant: "مساحة مولد",
  subscriber: "مشترك",
  meter: "عداد",
  meter_reading: "قراءة عداد",
  tariff: "تعرفة",
  generator: "مولد",
  invoice: "فاتورة",
  invoice_share_link: "رابط فاتورة",
  payment: "دفعة",
  expense: "مصروف",
  company_account: "حساب مالي",
  staff_profile: "حساب فريق",
  tenant_messaging_configuration: "إعداد مراسلة",
  platform_announcement: "إعلان منصة",
  owner_quota_alert: "تنبيه حصة",
};
const arabicAuditValue = (value: string | undefined, map: Record<string, string>, label: string) =>
  value ? (map[value] ?? (label === "عنصر" ? "عنصر غير مصنف" : "عملية غير مصنفة")) : label;

export default function AuditLogPage() {
  const { isAuthenticated, loading } = useAuth();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const enabled = Boolean(isAuthenticated && siteId);
  const auditQuery = trpc.powerhub.audit.list.useQuery({ siteId: siteId ?? 0 }, { enabled });
  if (loading) return <DashboardLayout><div className="grid min-h-[55vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><Card className="mx-auto mt-12 max-w-xl border-[#F5B800]/20 bg-[#111823]"><CardContent className="p-8 text-center"><ShieldCheck className="mx-auto h-9 w-9 text-[#F5B800]" /><h1 className="mt-4 text-xl font-extrabold text-white">سجل التدقيق محمي</h1><button className="mt-5 rounded-xl bg-[#F5B800] px-5 py-2 font-bold text-[#0D1117]" onClick={() => startLogin()}>تسجيل الدخول</button></CardContent></Card></DashboardLayout>;
  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823] p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><ClipboardCheck className="h-4 w-4" />رقابة وأمان</div><h1 className="mt-1 text-2xl font-extrabold text-white">سجل التدقيق</h1><p className="mt-2 text-sm text-slate-400">آخر 100 عملية حساسة داخل الفرع المحدد، معزولة عن سجلات أي مستأجر آخر.</p></div>{sitesQuery.data?.length ? <select aria-label="فلتر الفرع الموحد" className="h-10 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" value={siteId ?? ""} onChange={(event) => setSiteId(Number(event.target.value))}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select> : null}</header><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0">{auditQuery.isLoading ? <div className="grid h-48 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-[#F5B800]" /></div> : auditQuery.data?.length ? <div className="divide-y divide-white/7">{auditQuery.data.map((record) => <article key={record.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><Badge className="bg-[#F5B800]/10 text-[#F5B800]">{arabicAuditValue(record.entityType, entityNames, "عنصر")}</Badge><span className="font-bold text-white">{arabicAuditValue(record.action, actionNames, "عملية")}</span></div><p className="mt-2 font-mono text-xs text-slate-500">#{record.entityId}</p></div><time className="text-xs text-slate-400">{new Date(record.createdAt).toLocaleString("ar-IQ")}</time></article>)}</div> : <div className="py-16 text-center text-sm text-slate-500">لا توجد عمليات مسجلة لهذا الفرع حتى الآن.</div>}</CardContent></Card></div></DashboardLayout>;
}
