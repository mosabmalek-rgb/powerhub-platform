import { loadPdfDependencies } from "./lazy-report-deps";

export async function downloadReportHtmlAsPdf(element: HTMLElement, filename: string, options?: { landscape?: boolean; title?: string }) {
  const { html2canvas, jsPDF } = await loadPdfDependencies();
  const canvas = await html2canvas(element, { scale: 2, useCORS: true, backgroundColor: "#ffffff", windowWidth: element.scrollWidth || 794 });
  const orientation = options?.landscape ? "landscape" : "portrait";
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
}
