import { loadPdfDependencies } from "./lazy-report-deps";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('\"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseCssNumber(token: string, percentageScale = 1): number | null {
  if (token.toLowerCase() === "none") return 0;
  const isPercent = token.endsWith("%");
  const parsed = Number.parseFloat(isPercent ? token.slice(0, -1) : token);
  if (!Number.isFinite(parsed)) return null;
  return isPercent ? parsed / 100 * percentageScale : parsed;
}

function parseCssHue(token: string): number | null {
  const value = token.toLowerCase();
  if (value.endsWith("turn")) {
    const turns = Number.parseFloat(value.slice(0, -4));
    return Number.isFinite(turns) ? turns * 360 : null;
  }
  if (value.endsWith("rad")) {
    const radians = Number.parseFloat(value.slice(0, -3));
    return Number.isFinite(radians) ? radians * 180 / Math.PI : null;
  }
  if (value.endsWith("grad")) {
    const gradians = Number.parseFloat(value.slice(0, -4));
    return Number.isFinite(gradians) ? gradians * 0.9 : null;
  }
  const degrees = Number.parseFloat(value.endsWith("deg") ? value.slice(0, -3) : value);
  return Number.isFinite(degrees) ? degrees : null;
}

function oklabToRgbColor(lightness: number, a: number, b: number, alpha: number): string {
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.2914855480 * b;
  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;

  const linearChannels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  const toSrgb = (channel: number) => {
    const encoded = channel <= 0.0031308
      ? 12.92 * channel
      : 1.055 * Math.sign(channel) * Math.pow(Math.abs(channel), 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, encoded)) * 255);
  };
  const [red, green, blue] = linearChannels.map(toSrgb);
  const safeAlpha = Math.max(0, Math.min(1, alpha));
  return safeAlpha < 0.999999
    ? `rgba(${red}, ${green}, ${blue}, ${Number(safeAlpha.toFixed(4))})`
    : `rgb(${red}, ${green}, ${blue})`;
}

function normalizeOklabColor(model: string, body: string): string | null {
  const [componentsPart, alphaPart] = body.split("/");
  const components = (componentsPart ?? "").replaceAll(",", " ").trim().split(/\s+/);
  if (components.length !== 3) return null;
  const lightness = parseCssNumber(components[0]);
  const alpha = alphaPart === undefined ? 1 : parseCssNumber(alphaPart.trim());
  if (lightness === null || alpha === null) return null;

  if (model.toLowerCase() === "oklab") {
    const a = parseCssNumber(components[1], 0.4);
    const b = parseCssNumber(components[2], 0.4);
    if (a === null || b === null) return null;
    return oklabToRgbColor(lightness, a, b, alpha);
  }

  const chroma = parseCssNumber(components[1], 0.4);
  const hue = parseCssHue(components[2]);
  if (chroma === null || hue === null) return null;
  const angle = hue * Math.PI / 180;
  return oklabToRgbColor(lightness, chroma * Math.cos(angle), chroma * Math.sin(angle), alpha);
}

/**
 * html2canvas does not consistently parse modern CSS Color 4 functions.
 * Convert the Tailwind v4 oklch/oklab values used by the app to ordinary RGB
 * before the cloned report is rasterized.
 */
export function normalizePdfCssColors(value: string): string {
  return value.replace(/\b(oklch|oklab)\(([^()]*)\)/gi, (match, model: string, body: string) =>
    normalizeOklabColor(model, body) ?? match,
  );
}

function inlineCanvasSafeColors(source: HTMLElement, clone: HTMLElement) {
  const sourceNodes = [source, ...Array.from(source.querySelectorAll("*"))];
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll("*"))];

  sourceNodes.forEach((sourceNode, index) => {
    const targetNode = cloneNodes[index];
    if (!targetNode || !(targetNode instanceof HTMLElement || targetNode instanceof SVGElement)) return;

    const computed = window.getComputedStyle(sourceNode);
    for (let propertyIndex = 0; propertyIndex < computed.length; propertyIndex += 1) {
      const property = computed.item(propertyIndex);
      const value = computed.getPropertyValue(property);
      if (!/\b(?:oklch|oklab)\(/i.test(value)) continue;
      const normalized = normalizePdfCssColors(value);
      if (normalized !== value) targetNode.style.setProperty(property, normalized);
    }
  });
}

export async function downloadReportHtmlAsPdf(element: HTMLElement, filename: string, options?: { landscape?: boolean; title?: string }) {
  const { html2canvas, jsPDF } = await loadPdfDependencies();
  // Render a detached copy so PDF-specific table styling never changes the live page.
  const report = element.cloneNode(true) as HTMLElement;
  inlineCanvasSafeColors(element, report);
  report.style.boxSizing = "border-box";
  report.style.backgroundColor = "#ffffff";
  report.style.color = "#101828";
  report.style.lineHeight = "1.55";
  report.style.overflow = "visible";
  report.style.position = "relative";
  report.style.left = "0";
  report.style.top = "0";
  report.style.right = "auto";
  report.style.bottom = "auto";
  report.style.margin = "0";
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
