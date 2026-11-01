import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("public invoice and inquiry actions", () => {
  it("labels invoice link action as copy and copies directly instead of opening native share UI", () => {
    const billing = read("client/src/pages/BillingPage.tsx");
    expect(billing).toContain("نسخ رابط الفاتورة");
    expect(billing).toContain("copyTextSafely(url)");
    expect(billing).not.toContain('navigator.share({ title: "فاتورة PowerHub"');
    expect(billing).toContain("إظهار الفاتورة");
    expect(billing).toContain("setPreviewInvoiceUrl");
    expect(billing).toContain("<iframe title=\"معاينة الفاتورة\"");
    expect(billing).toContain("<Dialog open={previewInvoiceOpen}");
    expect(billing).toContain("setPreviewInvoiceOpen(true); updatePreviewStatus(\"loading\"); openInvoice.mutate");
    expect(billing).toContain("جارٍ تجهيز رابط الفاتورة…");
    expect(billing).not.toContain("openWindowSafely(");
    expect(billing).toContain("window.location.origin");
    expect(billing).toContain("result.path");
  });

  it("allows same-origin framing only for shared invoice previews", () => {
    const config = JSON.parse(read("vercel.json")) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
      functions: Re���q�^