import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

export type PortalInvoicePdfData = {
  portal: { displayName: string; primaryColor: string; accentColor: string };
  subscriber: { fullName: string; subscriberNo: string; phone: string; address: string | null };
  invoice: {
    invoiceNo: string;
    billingPeriod: string;
    issueDate: Date | string;
    dueDate: Date | string;
    previousReading: number;
    currentReading: number;
    consumptionKwh: number;
    pricePerKwh: number;
    fixedFee: number;
    taxAmount: number;
    discountAmount: number;
    totalAmount: number;
    paidAmount: number;
    balanceDue: number;
    status: string;
  };
  lines: Array<{ description: string; quantity: number; unitPrice: number; amount: number }>;
};

const currency = (value: number, digits = 2) => new Intl.NumberFormat("ar", { maximumFractionDigits: digits }).format(Number(value || 0));
const date = (value: Date | string) => new Intl.DateTimeFormat("ar", { dateStyle: "medium" }).format(new Date(value));
const statusLabel: Record<string, string> = { paid: "مدفوعة بالكامل", partially_paid: "مدفوعة جزئياً", issued: "مستحقة", overdue: "متأخرة" };
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] || character);
const safeColor = (color: string, fallback: string) => /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
const filePart = (value: string) => value.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 90);

export async function downloadSubscriberPortalInvoicePdf(data: PortalInvoicePdfData) {
  const primary = safeColor(data.portal.primaryColor, "#0D1117");
  const accent = safeColor(data.portal.accentColor, "#F5B800");
  const root = document.createElement("section");
  root.setAttribute("dir", "rtl");
  root.setAttribute("aria-hidden", "true");
  root.style.cssText = "position:fixed;top:0;left:-10000px;width:794px;background:#fff;color:#172033;font-family:Tajawal,Arial,sans-serif;z-index:-1;";
  const lines = data.lines.length ? data.lines.map((line) => `<tr><td>${escapeHtml(line.description)}</td><td>${currency(line.quantity, 3)}</td><td>${currency(line.unitPrice, 4)}</td><td class=amount>${currency(line.amount)}</td></tr>`).join("") : `<tr><td>استهلاك الطاقة</td><td>${currency(data.invoice.consumptionKwh, 3)}</td><td>${currency(data.invoice.pricePerKwh, 4)}</td><td class=amount>${currency(data.invoice.consumptionKwh * data.invoice.pricePerKwh)}</td></tr>`;
  root.innerHTML = `<style>
    *{box-sizing:border-box} .page{padding:38px 44px 42px;background:#fff}.head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:26px 28px;background:${primary};color:#fff;border-radius:18px}.brand{font-size:24px;font-weight:800;line-height:1.35}.sub{margin-top:5px;color:#d7dde6;font-size:13px}.badge{padding:8px 12px;border-radius:999px;background:${accent};color:${primary};font-size:12px;font-weight:800;white-space:nowrap}.title{margin:30px 0 18px;font-size:25px;font-weight:800;color:${primary}}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.box{padding:15px 16px;border:1px solid #e3e8ef;border-radius:12px;background:#fff}.label{font-size:11px;color:#6b778a;font-weight:700}.value{margin-top:5px;font-size:14px;color:#182235;font-weight:800}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0}.summary .box{background:#f7f9fc}.summary .value{font-size:18px;color:${primary}}.accent{color:${accent}!important}table{width:100%;border-collapse:collapse;margin-top:18px;overflow:hidden;border:1px solid #e3e8ef;border-radius:12px;font-size:12px}th{padding:11px 12px;background:${primary};color:#fff;text-align:right;font-weight:800}td{padding:11px 12px;border-bottom:1px solid #e8edf3;color:#364152}tr:last-child td{border-bottom:0}.amount{font-weight:800;color:#172033}.total{margin-top:18px;margin-right:auto;width:290px;padding:15px 17px;border-radius:12px;background:#fff8dc;border:1px solid #f3df97}.total-row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px;color:#536276}.total-main{margin-top:7px;padding-top:10px;border-top:1px solid #ead17b;font-size:18px;font-weight:800;color:${primary}}.foot{margin-top:28px;padding-top:14px;border-top:1px dashed #cbd5e1;text-align:center;font-size:10px;color:#718096}.muted{color:#68758a;font-size:12px;line-height:1.6}</style>
    <div class=page><header class=head><div><div class=brand>${escapeHtml(data.portal.displayName)}</div><div class=sub>فاتورة استهلاك الطاقة الكهربائية</div></div><div class=badge>${escapeHtml(statusLabel[data.invoice.status] || "فاتورة صادرة")}</div></header><h1 class=title>فاتورة رقم <span dir=ltr>${escapeHtml(data.invoice.invoiceNo)}</span></h1><section class=grid><div class=box><div class=label>بيانات المشترك</div><div class=value>${escapeHtml(data.subscriber.fullName)}</div><div class=muted>رقم مرجعي: <span dir=ltr>${escapeHtml(data.subscriber.subscriberNo)}</span><br>الهاتف: <span dir=ltr>${escapeHtml(data.subscriber.phone)}</span>${data.subscriber.address ? `<br>${escapeHtml(data.subscriber.address)}` : ""}</div></div><div class=box><div class=label>بيانات الفاتورة</div><div class=value>الفترة ${escapeHtml(data.invoice.billingPeriod)}</div><div class=muted>تاريخ الإصدار: ${date(data.invoice.issueDate)}<br>تاريخ الاستحقاق: ${date(data.invoice.dueDate)}</div></div></section><section class=summary><div class=box><div class=label>الاستهلاك</div><div class=value>${currency(data.invoice.consumptionKwh, 3)} <small>kWh</small></div></div><div class=box><div class=label>القراءة السابقة / الحالية</div><div class=value>${currency(data.invoice.previousReading, 3)} / ${currency(data.invoice.currentReading, 3)}</div></div><div class=box><div class=label>الرصيد المتبقي</div><div class="value accent">${currency(data.invoice.balanceDue)} شيكل</div></div></section><table><thead><tr><th>البند</th><th>الكمية</th><th>سعر الوحدة</th><th>المبلغ</th></tr></thead><tbody>${lines}</tbody></table><section class=total><div class=total-row><span>إجمالي الفاتورة</span><b>${currency(data.invoice.totalAmount)} شيكل</b></div><div class=total-row><span>المسدد</span><b>${currency(data.invoice.paidAmount)} شيكل</b></div><div class="total-row total-main"><span>المتبقي للسداد</span><span>${currency(data.invoice.balanceDue)} شيكل</span></div></section><footer class=foot>تم إنشاء هذه الفاتورة إلكترونياً عبر PowerHub · إدارة الطاقة بذكاء</footer></div>`;
  document.body.appendChild(root);
  try {
    const canvas = await html2canvas(root, { scale: 2, useCORS: true, backgroundColor: "#ffffff", windowWidth: 794 });
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    const width = 210;
    const height = (canvas.height * width) / canvas.width;
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, width, height, undefined, "FAST");
    pdf.save(`فاتورة_${filePart(data.invoice.invoiceNo)}_${filePart(data.subscriber.fullName)}.pdf`);
  } finally {
    root.remove();
  }
}
