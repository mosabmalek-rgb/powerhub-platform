import {describe,it,expect} from "vitest";
import {summarizeServiceCycleBilling, InvalidServiceCycleBilling} from "./financial-service-cycle-bridge";
const date=(x:string)=>new Date(x);
const invoice=(overrides:Record<string,unknown>={})=>({
  id:31,status:"partially_paid",totalAmount:2471.50,taxAmount:0,
  issueDate:date("2026-11-01T12:07:25Z"),
  cycleStartAt:date("2026-09-30T21:00:00Z"),
  cycleEndAt:date("2026-10-31T21:59:59.999Z"),
  ...overrides,
});
const asOf=date("2026-11-09T09:00:00Z");
describe("service-cycle billing read-only diagnostic",()=>{
 it("finds October service billing even when invoice was issued in November",()=>{
  const x=summarizeServiceCycleBilling("2026-10-01","2026-10-31",asOf,[invoice()]);
  expect(x.issuedInvoiceCount).toBe(1);
  expect(x.billedGross).toBe(2471.5);
  expect(x.billedExTax).toBe(2471.5);
  expect(x.completedCount).toBe(1);
  expect(x.issuedOutsideRangeCount).toBe(1);
  expect(x.issuedOutsideRangeBilledGross).toBe(2471.5);
  expect(x.isRecognizedRevenue).toBe(false);
 });
 it("classifies a November cycle as in progress, not earned, on November 9",()=>{
  const x=summarizeServiceCycleBilling("2026-11-01","2026-11-30",asOf,[invoice({
   id:32, totalAmount:51,
   cycleStartAt:date("2026-10-31T22:00:00Z"),
   cycleEndAt:date("2026-11-30T21:59:59.999Z"),
  })]);
  expect(x.inProgressCount).toBe(1);
  expect(x.ongoingCycleBilledGross).toBe(51);
  expect(x.completedCount).toBe(0);
  expect(x.fullyInsideCount).toBe(1);
 });
 it("keeps cross-boundary totals intact and does not invent proration",()=>{
  const x=summarizeServiceCycleBilling("2026-10-10","2026-10-20",asOf,[invoice()]);
  expect(x.crossBoundaryCount).toBe(1);
  expect(x.billedGross).toBe(2471.5);
 });
 it("excludes draft and cancelled statuses but rejects duplicate invoice identities",()=>{
  const x=summarizeServiceCycleBilling("2026-10-01","2026-10-31",asOf,[
   invoice({id:2,status:"draft"}),invoice({id:3,status:"cancelled"})]);
  expect(x.ignoredStatusesCount).toBe(2);
  expect(x.issuedInvoiceCount).toBe(0);
  expect(()=>summarizeServiceCycleBilling("2026-10-01","2026-10-31",asOf,[invoice(),invoice()]))
   .toThrow(InvalidServiceCycleBilling);
 });
 it("splits gross from tax and rejects impossible amounts or cycle bounds",()=>{
  const x=summarizeServiceCycleBilling("2026-10-01","2026-10-31",asOf,[invoice({totalAmount:110,taxAmount:10})]);
  expect(x.billedExTax).toBe(100);
  expect(()=>summarizeServiceCycleBilling("2026-10-01","2026-10-31",asOf,[invoice({totalAmount:5,taxAmount:8})])).toThrow();
  expect(()=>summarizeServiceCycleBilling("2026-10-01","2026-10-31",asOf,[invoice({cycleEndAt:date("2026-09-01")})])).toThrow();
  expect(()=>summarizeServiceCycleBilling("2026-02-30","2026-10-31",asOf,[])).toThrow();
 });
 it("filters widened UTC query results by the exact Gaza-local day",()=>{
  const x=summarizeServiceCycleBilling("2026-11-01","2026-11-30",asOf,[invoice()]);
  expect(x.issuedInvoiceCount).toBe(0);
  expect(x.billedGross).toBe(0);
 });
});
