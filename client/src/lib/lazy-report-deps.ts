export async function loadExcelJS() {
  return import("exceljs");
}

export async function loadPdfDependencies() {
  const [{ default: html2canvasModule }, jspdfModule] = await Promise.all([
    import("html2canvas"),
    import("jspdf"),
  ]);

  return {
    html2canvas: html2canvasModule,
    jsPDF: jspdfModule.jsPDF,
  };
}
