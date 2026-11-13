import {describe,it,expect} from "vitest";
import ExcelJS from "exceljs";
import {buildGLExportRows,serializeGLCsv,buildGLPdfHtml,type GLExportData} from "./financial-gl-comparison-export";
function fixture(count=1100):GLExportData{
 return {
  tenantId:44,siteId:73,tenantName:"مولد <السلام> & الشركة",siteName:"=INJECT() الفرع",
  currentPeriod:"2026-10",previousPeriod:"2026-09",
  currentPeriodStart:"2026-10-01",currentPeriodEnd:"2026-10-31",
  previousPeriodStart:"2026-09-01",previousPeriodEnd:"2026-09-30",
  currentReviewStatus:"locked",previousReviewStatus:"locked",
  recognitionPolicyVersion:"gaza-invoice-service-calendar-days-v1",
  currency:"ILS",periodTimeZone:"Asia/Gaza",generatedAt:"2026-11-13T10:00:00Z",
  snapshotFingerprint:"a".repeat(32),status:"COMPARABLE_PRELIMINARY",
  canExport:true,blockers:[],accountingCertification:"NOT_CERTIFIED",
  isFinalFinancialStatement:false,currentGLEntryCount:1400,previousGLEntryCount:1200,
  metrics:[{key:"serviceRevenue",current:120.25,previous:100,delta:20.25,percentage:20.25},
   {key:"provisionalNetResult",current:-5.5,previous:0,delta:-5.5,percentage:null}],
  accountRows:Array.from({length:count},(_,i)=>({
   code:String(i+1000),name:i===count-1?"آخر حساب < > &":"حساب "+i,
   accountClass:"asset",current:i+0.25,previous:i+1.5,delta:-1.25,percentage:-83.33,
  })),
 };
}
describe("Phase C export exactness, multi-page size, and safe Arabic metadata",()=>{
 it("exports all 1100 account rows, identity and numeric values without a page-one cap",()=>{
  const rows=buildGLExportRows(fixture());
  expect(rows).toHaveLength(17+1+1+2+1+1+1100);
  expect(rows.at(-1)).toEqual(["2099","آخر حساب < > &","asset",1099.25,1100.5,-1.25,-83.33]);
  expect(rows.some(r=>r[0]==="معرّف لقطة المصدر"&&r[1]==="a".repeat(32))).toBe(true);
  expect(rows.some(r=>r[0]==="حالة الاعتماد"&&String(r[1]).includes("NOT_CERTIFIED"))).toBe(true);
 });
 it("CSV protects formula text while retaining signed numeric amounts and actual percent unit",()=>{
  const csv=serializeGLCsv(buildGLExportRows(fixture(3)));
  expect(csv.startsWith("\ufeff")).toBe(true);
  expect(csv).toContain('"\'=INJECT() الفرع"');
  expect(csv).toContain(",-5.5,0,-5.5,");
  expect(csv).toContain('"النسبة (%)"');
  expect(csv).toContain(",20.25\r\n");
 });
 it("creates a valid real Excel workbook with all rows and numeric cells",async()=>{
  const rows=buildGLExportRows(fixture(1100));
  const workbook=new ExcelJS.Workbook();
  const sheet=workbook.addWorksheet("مقارنة المحاسبة",{views:[{rightToLeft:true}]});
  rows.forEach(r=>sheet.addRow(r));
  const binary=await workbook.xlsx.writeBuffer();
  const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(binary as Buffer);
  const recreated=loaded.getWorksheet("مقارنة المحاسبة");
  expect(recreated?.rowCount).toBe(rows.length);
  expect(recreated?.getRow(rows.length).getCell(4).value).toBe(1099.25);
  expect(recreated?.getRow(rows.length).getCell(6).value).toBe(-1.25);
  expect(recreated?.getRow(rows.length).getCell(7).value).toBe(-83.33);
 });
 it("PDF HTML contains every account and escapes injected markup",()=>{
  const html=buildGLPdfHtml(fixture(1100));
  expect(html).toContain("dir='rtl'");
  expect(html).toContain("NOT_CERTIFIED");
  expect(html).toContain("آخر حساب &lt; &gt; &amp;");
  expect(html).toContain("مولد &lt;السلام&gt; &amp; الشركة");
  expect(html).toContain("=INJECT() الفرع");
  expect((html.match(/<tr>/g)??[]).length).toBe(1+17+1+2+1+1100);
 });
 it("never produces a file from blocked, forged certification or incomplete identity",()=>{
  for(const patch of [
   {status:"BLOCKED"},{canExport:false},{accountingCertification:"CERTIFIED"},
   {isFinalFinancialStatement:true},{recognitionPolicyVersion:null},
   {currency:"USD"},{snapshotFingerprint:"stale"},
  ])expect(()=>buildGLExportRows({...fixture(3),...patch} as GLExportData))
    .toThrow("GL_EXPORT_UNVERIFIED_SNAPSHOT");
 });
});
