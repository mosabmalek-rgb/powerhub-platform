import { loadPdfDependencies } from "@/lib/lazy-report-deps";

type ReportPdfOptions = {
  filename: string;
  orientation?: "portrait" | "landscape";
  margin?: number;
  scale?: number;
};

export async function downloadReportElementPdf(element: HTMLElement, options: ReportPdfOptions) {
  const { html2canvas, jsPDF } = await loadPdfDependencies();
  const orientation = options.orientation ?? "portrait";
  const margin = options.margin ?? 18;
  const scale = options.scale ?? 2;

  const canvas = await html2canvas(element, {
    scale,
    useCORS: true,
    backgroundColor: "#ffffff",
    windowWidth: Math.max(element.scrollWidth, 794),
    logging: false,
  });

  const pdf = new jsPDF({ orientation, unit: "pt", format: "a4", compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const contentWidth = pageWidth - margin * 2;
  const contentHeight = pageHeight - margin * 2;
  const renderedHeight = (canvas.height * contentWidth) / canvas.width;
  const totalPages = Math.max(1, Math.ceil(renderedHeight / contentHeight));

  for (let page = 0; page < totalPages; page += 1) {
    if (page > 0) pdf.addPage();
    const sourceY = (page * contentHeight * canvas.width) / contentWidth;
    const sourceHeight = Math.min(canvas.height - sourceY, (contentHeight * canvas.width) / contentWidth);
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = canvas.width;
    pageCanvas.height = Math.max(1, Math.ceil(sourceHeight));
    const context = pageCanvas.getContext("2d");
    if (!context) throw new Error("تعذر تجهيز صورة صفحة التقرير.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    context.drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, canvas.width, sourceHeight);

    const pageRenderedHeight = (pageCanvas.height * contentWidth) / pageCanvas.width;
    pdf.addImage(pageCanvas.toDataURL("image/png"), "PNG", margin, margin, contentWidth, Math.min(contentHeight, pageRenderedHeight), undefined, "FAST");

    pdf.setFontSize(7);
    pdf.setTextColor(100, 112, 128);
    pdf.text(String(page + 1), pageWidth - margin, pageHeight - 7, { align: "right" });
  }

  pdf.save(options.filename);
}
