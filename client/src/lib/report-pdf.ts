import { loadPdfDependencies } from "./lazy-report-deps";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('\"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function downloadReportHtmlAsPdf(element: HTMLElement, filename: string, options?: { landscape?: boolean; title?: string }) {
  const { html2canvas, jsPDF } = await loadPdfDependencies();
  // Render a detached copy so PDF-specific table styling never changes the live page.
  const report = element.cloneNode(true) as HTMLElement;
  report.style.boxSizing = "border-box";
  report.style.backgroundColor = "#ffffff";
  report.style.color = "#101828";
  report.style.lineHeight = "1.55";
  report.style.overflow = "visible";
  report.querySelectorAll<HTMLElement>("table").forEach((table) => {
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    table.style.borderSpacing = "0";
    table.style.marginTop = table.style.marginTop || "14px";
    table.style.marginBottom = table.style.marginBottom || "18px";
  });
  // A visible border on each cell gives every data cell a complete four-sided grid.
  report.querySelectorAll<HTMLElement>("th, td").forEach((cell) => {
    cell.style.boxSizing = "border-box";
    cell.style.border = "1px solid #9CA8B7";
    cell.style.padding = "9px 11px";
    cell.style.lineHeight = "1.55";
    cell.style.verticalAlign = "middle";
    cell.style.whiteSpace = "normal";
    cell.style.overflowWrap = "anywhere";
  });
  report.querySelectorAll<HTMLElement>("th").forEach((cell) => {
    cell.style.fontWeight = "800";
    cell.style.paddingTop = "11px";
    cell.style.paddingBottom = "11px";
  });
  report.querySelectorAll<HTMLElement>("h1, h2, h3").forEach((heading) => {
    heading.style.lineHeight = "1.4";
    heading.style.marginBottom = heading.style.marginBottom || "16px";
    heading.style.overflowWrap = "anywhere";
  });
  const orientation = options?.landscape ? "landscape" : "portrait";
  const host = document.createElement("div");
  host.dir = element.dir || "rtl";
  host.style.cssText = "position:fixed;left:-30000px;top:0;pointer-events:none;z-index:-1;background:#fff;overflow:visible";
  const width = Math.max(element.scrollWidth || 0, Math.round(element.getBoundingClientRect().width) || 0, Number.parseFloat(element.style.width) || 0, options?.landscape ? 1100 : 794);
  host.style.width = width + "px";
  report.style.width = width + "px";
  report.style.maxWidth = "none";
  report.style.height = "auto";
  report.style.maxHeight = "none";
  report.style.overflow = "visible";
  host.appendChild(report);
  document.body.appendChild(host);
  try {
    const canvas = await html2canvas(report, { scale: 2, useCORS: true, backgroundColor: "#ffffff", windowWidth: width, windowHeight: Math.max(794, report.scrollHeight || 0), scrollX: 0, scrollY: 0 });
    const pdf = new jsPDF({ orientation, unit: "pt", format: "a4", compress: true });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 24;
    const imageWidth = pageWidth - margin * 2;
    const imageHeight = canvas.height * imageWidth / canvas.width;
    const usableHeight = pageHeight - margin * 2;
    const pixelsPerPage = Math.max(1, Math.floor(canvas.height * usableHeight / imageHeight));
    let offset = 0;
    let page = 0;
    while (offset < canvas.height) {
      if (page > 0) pdf.addPage();
      const sliceHeight = Math.min(pixelsPerPage, canvas.height - offset);
      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = sliceHeight;
      const context = slice.getContext("2d");
      if (!context) throw new Error("تعذر تجهيز صفحة التقرير.");
      context.drawImage(canvas, 0, offset, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
      const renderedHeight = sliceHeight * imageWidth / canvas.width;
      pdf.addImage(slice.toDataURL("image/png"), "PNG", margin, margin, imageWidth, renderedHeight, undefined, "FAST");
      pdf.setFontSize(7);
      pdf.setTextColor(100);
      pdf.text(`PowerHub · ${page + 1}`, pageWidth - margin, pageHeight - 10, { align: "right" });
      offset += sliceHeight;
      page += 1;
    }
    if (options?.title) pdf.setProperties({ title: options.title, creator: "PowerHub" });
    pdf.save(filename);
  } finally {
    host.remove();
  }
}
