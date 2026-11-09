import {describe,it,expect} from "vitest";
import {
  allocateBilledServiceByGazaMonth as allocate,
  SERVICE_RECOGNITION_POLICY_VERSION,InvalidServiceAllocation
} from "./financial-service-recognition";
const dt=(s:string)=>new Date(s);
describe("Phase A1 inclusive Gaza calendar day allocation — provisional only",()=>{
 it("allocates a cross-month service invoice, excluding billed tax exactly",()=>{
   const result=allocate({
     cycleStartAt:dt("2026-10-19T21:00:00Z"), // Oct 20 local
     cycleEndAt:dt("2026-11-18T21:59:59.999Z"), // Nov 19 local
     billedGrossMinor:3410n,billedTaxMinor:310n,
   });
   expect(result.totalServiceDays).toBe(31);
   expect(result.totalExTaxMinor).toBe(3100n);
   expect(result.months).toEqual([
     {period:"2026-10",serviceDays:12,allocatedExTaxMinor:1200n},
     {period:"2026-11",serviceDays:19,allocatedExTaxMinor:1900n},
   ]);
   expect(result.policyVersion).toBe(SERVICE_RECOGNITION_POLICY_VERSION);
   expect(result.isRecognizedRevenue).toBe(false);
   expect(result.isCompleteAccrualStatement).toBe(false);
 });
 it("conserves cents across periods without floats, even for one minor unit",()=>{
   const x=allocate({cycleStartAt:dt("2026-10-30T22:00:00Z"),
     cycleEndAt:dt("2026-11-02T21:59:59Z"),billedGrossMinor:1n,billedTaxMinor:0n});
   expect(x.months.reduce((n,m)=>n+m.allocatedExTaxMinor,0n)).toBe(1n);
   expect(x.months.reduce((n,m)=>n+m.serviceDays,0)).toBe(x.totalServiceDays);
 });
 it("counts 28 and 29 February days under Gaza local time",()=>{
   for(const [year,days] of [[2027,28],[2028,29]]){
     const x=allocate({cycleStartAt:dt(`${year}-02-01T00:00:00Z`),
       cycleEndAt:dt(`${year}-02-${days}T12:00:00Z`),
       billedGrossMinor:BigInt(days)*100n,billedTaxMinor:0n});
     expect(x.totalServiceDays).toBe(days);
     expect(x.months).toEqual([{period:`${year}-02`,serviceDays:days,
       allocatedExTaxMinor:BigInt(days)*100n}]);
   }
 });
 it("handles Gaza daylight-saving time without 23/25-hour day drift",()=>{
   const x=allocate({cycleStartAt:dt("2026-03-25T12:00:00Z"),
     cycleEndAt:dt("2026-04-02T12:00:00Z"),
     billedGrossMinor:900n,billedTaxMinor:0n});
   expect(x.totalServiceDays).toBe(9);
   expect(x.months.map(m=>m.serviceDays)).toEqual([7,2]);
   expect(x.months.reduce((s,m)=>s+m.allocatedExTaxMinor,0n)).toBe(900n);
 });
 it("rejects reversed timestamps, tax exceeding gross, and lengthy cycles",()=>{
   expect(()=>allocate({cycleStartAt:dt("2026-10-02T00:00:00Z"),
     cycleEndAt:dt("2026-10-01T00:00:00Z"),billedGrossMinor:10n,billedTaxMinor:0n}))
     .toThrow("INVALID_CYCLE_ORDER");
   expect(()=>allocate({cycleStartAt:dt("2026-10-01T00:00:00Z"),
     cycleEndAt:dt("2026-10-02T00:00:00Z"),billedGrossMinor:10n,billedTaxMinor:11n}))
     .toThrow("INVALID_BILLING_OR_TAX");
   expect(()=>allocate({cycleStartAt:dt("2000-01-01T00:00:00Z"),
     cycleEndAt:dt("2026-01-01T00:00:00Z"),billedGrossMinor:10n,billedTaxMinor:0n}))
     .toThrow(InvalidServiceAllocation);
 });
});
