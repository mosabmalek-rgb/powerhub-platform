import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ChevronDown, ChevronUp, Download, Loader2, RefreshCw } from "lucide-react";
import { loadExcelJS } from "@/lib/lazy-report-deps";
import { downloadReportHtmlAsPdf, escapeHtml } from "@/lib/report-pdf";
import { toast } from "sonner";

type AgingRow = {
  document_type: "purchase_invoice" | "opening_balance";
  document_id: number | string;
  supplier_id: number | string;
  supplier_name: string;
  document_number: string;
  document_date: string;
  due_date: string;
  gross_amount: number | string;
  paid_amount: number | string;
  credit_amount: number | string;
  outstanding_amount: number | string;
  days_overdue: number | string;
  aging_bucket: string;
};

type AgingResult = {
  as_of_date: string;
  totals: {
    not_due: number | string;
    days_1_30: number | string;
    days_31_60: number | string;
    days_61_90: number | string;
    days_91_plus: number | string;
    total_outstanding: number | string;
  };
  rows: AgingRow[];
};

function amount(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return `₪${new Intl.NumberFormat("ar-PS", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(parsed) ? parsed : 0)}`;
}

export default function InventorySupplierPayablesAgingPanel({
  siteId,
  isAuthenticated,
  canViewSupplierLedger,
}: {
  siteId: number;
  isAuthenticated: boolean;
  canViewSupplierLedger: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [asOfDate, setAsOfDate] = useState(() => {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  });
  const query = trpc.powerhub.inventory.supplierPayablesAging.useQuery(
    { siteId, asOfDate },
    { enabled: Boolean(siteId && isAuthenticated && canViewSupplierLedger), staleTime: 15_000 },
  );
  const branding = trpc.powerhub.reportBranding.get.useQuery(
    { siteId },
    { enabled: Boolean(siteId && isAuthenticated && canViewSupplierLedger), staleTime: 60_000 },
  );
  const exportExcel = async () => {
    if (!result) { toast.error("حمّل تقرير أعمار الذمم بنجاح قبل التصدير."); return; }
    try {
      const { default: ExcelJS } = await loadExcelJS();
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "PowerHub";
      const sheet = workbook.addWorksheet("أعمار ذمم الموردين", { views: [{ rightToLeft: true, state: "frozen", ySplit: 8 }] });
      sheet.addRows([
        [branding.data?.companyName || "PowerHub", "تقرير أعمار ذمم الموردين"],
        ["الفرع", siteId],
        ["محسوب حتى تاريخ", result.as_of_date],
        ["غير مستحقة", Number(totals?.not_due ?? 0)],
        ["متأخرة 1–30 يومًا", Number(totals?.days_1_30 ?? 0)],
        ["متأخرة 31–60 يومًا", Number(totals?.days_31_60 ?? 0)],
        ["متأخرة 61–90 يومًا", Number(totals?.days_61_90 ?? 0)],
        ["متأخرة أكثر من 90 يومًا", Number(totals?.days_91_plus ?? 0)],
        ["إجمالي المستحق", Number(totals?.total_outstanding ?? 0)],
        [],
        ["المورد", "نوع المستند", "المرجع", "تاريخ المستند", "تاريخ الاستحقاق", "قيمة المستند", "المدفوع", "المرتجعات/الائتمان", "المتبقي", "أيام التأخير"],
        ...result.rows.map((row) => [
          row.supplier_name,
          row.document_type === "purchase_invoice" ? "فاتورة مشتريات" : "رصيد افتتاحي",
          row.document_number,
          row.document_date,
          row.due_date,
          Number(row.gross_amount),
          Number(row.paid_amount),
          Number(row.credit_amount),
          Number(row.outstanding_amount),
          Number(row.days_overdue),
        ]),
      ]);
      sheet.columns = [{width:30},{width:20},{width:24},{width:18},{width:18},{width:18},{width:18},{width:22},{width:18},{width:16}];
      sheet.getRow(1).font = { bold: true, size: 14 };
      sheet.getRow(11).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(11).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } };
      sheet.autoFilter = { from: { row: 11, column: 1 }, to: { row: 11, column: 10 } };
      const buffer = await workbook.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "powerhub-supplier-payables-aging-" + siteId + "-" + result.as_of_date + ".xlsx";
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      toast.success("تم تصدير تقرير أعمار الذمم إلى Excel.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذر تصدير تقرير أعمار الذمم إلى Excel.");
    }
  };
  const exportPdf = async () => {
    if (!result) { toast.error("حمّل تقرير أعمار الذمم بنجاح قبل التصدير."); return; }
    if (result.rows.length > 5_000) { toast.error("تقرير الذمم يتجاوز 5,000 بند. استخدم Excel أو ضيّق نطاق التقرير."); return; }
    let root: HTMLDivElement | undefined;
    try {
      root = document.createElement("div");
      root.dir = "rtl";
      root.style.cssText = "position:fixed;left:-20000px;top:0;width:1200px;background:#fff;color:#111827;padding:32px;font-family:Arial,sans-serif;direction:rtl;text-align:right";
      const cell = (value: unknown) => "<td style=\\"border:1px solid #d1d5db;padding:5px;vertical-align:top\\">" + escapeHtml(String(value ?? "—")) + "</td>";
      const headers = ["المورد","نوع المستند","المرجع","تاريخ المستند","الاستحقاق","قيمة المستند","المدفوع","الائتمان","المتبقي","التأخير"];
      const table = "<table style=\\"width:100%;border-collapse:collapse;margin:16px 0;font-size:10px\\"><thead><tr style=\\"background:#111827;color:#fff\\">" + headers.map((h) => "<th style=\\"border:1px solid #9ca3af;padding:6px\\">" + escapeHtml(h) + "</th>").join("") + "</tr></thead><tbody>" + result.rows.map((row) => "<tr>" + [
        row.supplier_name,
        row.document_type === "purchase_invoice" ? "فاتورة مشتريات" : "رصيد افتتاحي",
        row.document_number,
        row.document_date,
        row.due_date,
        amount(row.gross_amount),
        amount(row.paid_amount),
        amount(row.credit_amount),
        amount(row.outstanding_amount),
        Number(row.days_overdue) > 0 ? Number(row.days_overdue) + " يومًا" : "غير متأخر",
      ].map(cell).join("") + "</tr>").join("") + "</tbody></table>";
      root.innerHTML = "<header style=\\"display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:3px solid #d4a017;padding-bottom:10px\\"><div><h1 style=\\"font-size:22px;margin:0\\">" + escapeHtml(branding.data?.companyName || "PowerHub") + " — أعمار ذمم الموردين</h1><p>الفرع: " + siteId + " | حتى تاريخ: " + escapeHtml(result.as_of_date) + "</p></div>" + (branding.data?.logoUrl ? "<img alt=\\"شعار الشركة\\" src=\\"" + escapeHtml(branding.data.logoUrl) + "\\" style=\\"max-width:150px;max-height:70px;object-fit:contain\\">" : "") + "</header><h2>ملخص الذمم</h2><p>غير مستحقة: " + escapeHtml(amount(totals?.not_due)) + " | 1–30: " + escapeHtml(amount(totals?.days_1_30)) + " | 31–60: " + escapeHtml(amount(totals?.days_31_60)) + " | 61–90: " + escapeHtml(amount(totals?.days_61_90)) + " | 91+: " + escapeHtml(amount(totals?.days_91_plus)) + " | الإجمالي: " + escapeHtml(amount(totals?.total_outstanding)) + "</p><h2>تفاصيل الذمم</h2>" + table;
      document.body.appendChild(root);
      await downloadReportHtmlAsPdf(root, "أعمار-ذمم-الموردين-" + siteId + ".pdf", { landscape: true, title: "أعمار ذمم الموردين - PowerHub" });
      toast.success("تم إنشاء تقرير PDF عربي لأعمار الذمم.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذر إنشاء تقرير PDF لأعمار الذمم.");
    } finally {
      root?.remove();
    }
  };
  const result = query.data as unknown as AgingResult | undefined;
  const totals = result?.totals;

  if (!canViewSupplierLedger) return null;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>أعمار ذمم الموردين</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">الأرصدة المتبقية بعد احتساب الدفعات المرحلة والمرتجعات والاستردادات النقدية حتى التاريخ المحدد.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm">حتى تاريخ
            <Input className="mt-1" type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} />
          </label>
          <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
            <RefreshCw className="ml-2 h-4 w-4" /> تحديث
          </Button>
          <Button type="button" variant="outline" onClick={() => setExpanded((current) => !current)}>
            {expanded ? <ChevronUp className="ml-2 h-4 w-4" /> : <ChevronDown className="ml-2 h-4 w-4" />}
            {expanded ? "إخفاء التفاصيل" : "عرض التفاصيل"}
          </Button>
          <Button type="button" variant="outline" disabled={!result || query.isFetching} onClick={() => void exportExcel()}><Download className="ml-2 h-4 w-4" />Excel</Button>
          <Button type="button" variant="outline" disabled={!result || query.isFetching} onClick={() => void exportPdf()}><Download className="ml-2 h-4 w-4" />PDF عربي</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading && !result ? <p className="py-5 text-center text-muted-foreground"><Loader2 className="ml-2 inline h-4 w-4 animate-spin" /> جارٍ تحميل أعمار الديون…</p>
          : query.error ? <div className="space-y-3 py-4 text-center"><p className="text-destructive">تعذر تحميل تقرير الذمم. لم نعرض أرقامًا تقديرية.</p><Button type="button" variant="outline" onClick={() => void query.refetch()}>إعادة المحاولة</Button></div>
          : result ? <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              {[
                ["غير مستحقة", totals?.not_due],
                ["متأخرة 1–30 يومًا", totals?.days_1_30],
                ["متأخرة 31–60 يومًا", totals?.days_31_60],
                ["متأخرة 61–90 يومًا", totals?.days_61_90],
                ["متأخرة أكثر من 90 يومًا", totals?.days_91_plus],
                ["إجمالي المستحق", totals?.total_outstanding],
              ].map(([label, value], index) => <div key={String(label)} className={`rounded-md border p-3 ${index === 5 ? "bg-muted/50" : ""}`}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{amount(value as number | string | undefined)}</p>
              </div>)}
            </div>
            {expanded ? result.rows.length === 0 ? <p className="rounded-md border p-5 text-center text-muted-foreground">لا توجد ذمم مفتوحة حتى التاريخ المحدد.</p>
              : <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[1080px] text-right text-sm">
                  <thead className="bg-muted/60"><tr>{["المورد","نوع المستند","المرجع","تاريخ المستند","تاريخ الاستحقاق","قيمة المستند","المدفوع","المرتجعات/الائتمان","المتبقي","التأخير"].map((title) => <th key={title} className="p-3 font-semibold">{title}</th>)}</tr></thead>
                  <tbody>{result.rows.map((row) => {
                    const days = Number(row.days_overdue);
                    return <tr key={`${row.document_type}:${row.document_id}`} className="border-t">
                      <td className="p-3 font-medium">{row.supplier_name}<span className="block text-xs text-muted-foreground">#{row.supplier_id}</span></td>
                      <td className="p-3">{row.document_type === "purchase_invoice" ? "فاتورة مشتريات" : "رصيد افتتاحي"}</td>
                      <td className="p-3">{row.document_number || "—"}</td>
                      <td className="p-3 whitespace-nowrap">{row.document_date || "—"}</td>
                      <td className="p-3 whitespace-nowrap">{row.due_date || "—"}</td>
                      <td className="p-3 whitespace-nowrap">{amount(row.gross_amount)}</td>
                      <td className="p-3 whitespace-nowrap">{amount(row.paid_amount)}</td>
                      <td className="p-3 whitespace-nowrap">{amount(row.credit_amount)}</td>
                      <td className="p-3 whitespace-nowrap font-semibold">{amount(row.outstanding_amount)}</td>
                      <td className={`p-3 whitespace-nowrap ${days > 0 ? "font-medium text-destructive" : "text-muted-foreground"}`}>{days > 0 ? `${days} يومًا` : "غير متأخر"}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div> : null}
            {expanded && result.as_of_date ? <p className="text-xs text-muted-foreground">التقرير محسوب حتى {result.as_of_date} ويشمل الفواتير المعتمدة والأرصدة الافتتاحية المفتوحة في الفرع الحالي فقط.</p> : null}
          </> : null}
      </CardContent>
    </Card>
  );
}
