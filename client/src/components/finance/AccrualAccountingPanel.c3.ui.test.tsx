// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import {render,screen,cleanup} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import AccrualAccountingPanel from "./AccrualAccountingPanel";

const state=vi.hoisted(()=>({
  readinessStatus:"BLOCKED",
  readinessError:false,readinessFetching:false,
  reviewStatus:"unprepared",drift:false,
  invoiceCount:1,inventoryCount:1,
  lock:vi.fn(),invalidate:vi.fn().mockResolvedValue(undefined),
}));
const query=(data:unknown,error=false,fetching=false)=>({
 data,isLoading:false,isError:error,isFetching:fetching,refetch:vi.fn(),
});
vi.mock("sonner",()=>({toast:{success:vi.fn(),error:vi.fn()}}));
vi.mock("@/lib/trpc",()=>({
 trpc:{
  useUtils:()=>({powerhub:{reports:{
   accrualMonthStatement:{invalidate:state.invalidate},
   accrualJournalList:{invalidate:state.invalidate},
   accrualPeriodReviewStatus:{invalidate:state.invalidate},
   accrualCloseReadiness:{invalidate:state.invalidate},
  }}}),
  powerhub:{reports:{
   accrualMonthStatement:{useQuery:()=>query({
    serviceBillingExTax:0,revenueAfterAdjustments:0,operatingCostsAfterAdjustments:0,
    nonOperatingCostsAfterAdjustments:0,provisionalNetAfterAdjustments:0,
    purchaseGrossNotExpensed:0,draftPayrollCount:0,unreconciledPayrollPayoutCount:0,
    missingCycleCount:0,uncompletedInvoiceCount:state.invoiceCount,
    unclassifiedInventoryIssueCount:state.inventoryCount,
    journalAdjustments:{revenue:0,postedCount:0,draftCount:0},
   })},
   accrualJournalList:{useQuery:()=>query([])},
   accrualPeriodReviewStatus:{useQuery:()=>query({
    status:state.reviewStatus,preparedByUserId:4,
    evidence:{},driftDetected:state.drift,
   })},
   accrualCloseReadiness:{useQuery:()=>query({
    status:state.readinessStatus,
    blockers:state.readinessStatus==="BLOCKED"
     ?[{code:"UNCLASSIFIED_STOCK_ISSUE",label:"مخزون غير مصنف",count:state.inventoryCount}]
     :[],
    reviewRequirements:[],accountingCertification:"NOT_CERTIFIED",
   },state.readinessError,state.readinessFetching)},
   accrualPeriodReviewSave:{useMutation:()=>({isPending:false,mutateAsync:vi.fn()})},
   accrualPeriodReviewLock:{useMutation:()=>({isPending:false,mutateAsync:state.lock})},
   accrualJournalCreate:{useMutation:()=>({isPending:false,mutateAsync:vi.fn()})},
   accrualJournalPost:{useMutation:()=>({isPending:false,mutateAsync:vi.fn()})},
   accrualJournalReverse:{useMutation:()=>({isPending:false,mutateAsync:vi.fn()})},
   accrualJournalVoid:{useMutation:()=>({isPending:false,mutateAsync:vi.fn()})},
  }},
 },
}));
const mount=()=>render(<AccrualAccountingPanel siteId={1} period="2026-11" active={true}/>);
beforeEach(()=>{
 state.readinessStatus="BLOCKED";state.readinessError=false;state.readinessFetching=false;
 state.reviewStatus="unprepared";state.drift=false;
 state.invoiceCount=1;state.inventoryCount=1;
 state.lock.mockReset();state.invalidate.mockClear();
});
afterEach(()=>cleanup());

describe("C3 UI close state and stale-denial acceptance",()=>{
 it("shows invoice/inventory blockers and disables lock for BLOCKED",()=>{
  mount();
  expect(screen.getByText(/حالة الجاهزية: معطّل بسبب مصادر/)).toBeInTheDocument();
  expect(screen.getAllByText(/حركات مخزون غير مصنفة/).length).toBeGreaterThan(0);
  expect(screen.getByRole("button",{name:"اعتماد وإقفال المراجعة"})).toBeDisabled();
  expect(state.lock).not.toHaveBeenCalled();
 });
 it("reports REVIEW_REQUIRED without letting a draft lock",()=>{
  state.readinessStatus="REVIEW_REQUIRED";state.reviewStatus="draft";
  state.invoiceCount=0;state.inventoryCount=0;mount();
  expect(screen.getByText(/تحتاج إلى إعداد أدلة المراجعة/)).toBeInTheDocument();
  expect(screen.getByRole("button",{name:"اعتماد وإقفال المراجعة"})).toBeDisabled();
 });
 it("permits only a clean draft to display its lock button as available",()=>{
  state.readinessStatus="READY_FOR_INDEPENDENT_REVIEW";
  state.reviewStatus="draft";state.invoiceCount=0;state.inventoryCount=0;mount();
  expect(screen.getByText(/جاهزة للعرض على مراجع مستقل فقط/)).toBeInTheDocument();
  expect(screen.getByRole("button",{name:"اعتماد وإقفال المراجعة"})).toBeEnabled();
  expect(state.lock).not.toHaveBeenCalled();
 });
 it("never offers another lock for LOCKED_NOT_CERTIFIED",()=>{
  state.readinessStatus="LOCKED_NOT_CERTIFIED";state.reviewStatus="locked";
  state.invoiceCount=0;state.inventoryCount=0;mount();
  expect(screen.getByText(/مراجعة مقفلة دون تصديق محاسبي/)).toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"اعتماد وإقفال المراجعة"})).not.toBeInTheDocument();
 });
 it("denies lock and hides stale readiness result on fresh authorization failure",()=>{
  state.readinessStatus="READY_FOR_INDEPENDENT_REVIEW";
  state.reviewStatus="draft";state.invoiceCount=0;state.inventoryCount=0;
  state.readinessError=true;mount();
  expect(screen.getByText(/لم ينجح فحص جاهزية الإقفال/)).toBeInTheDocument();
  expect(screen.queryByText(/حالة الجاهزية:/)).not.toBeInTheDocument();
  expect(screen.getByRole("button",{name:"اعتماد وإقفال المراجعة"})).toBeDisabled();
 });
 it("does not allow lock while readiness revalidation is in flight",()=>{
  state.readinessStatus="READY_FOR_INDEPENDENT_REVIEW";
  state.reviewStatus="draft";state.invoiceCount=0;state.inventoryCount=0;
  state.readinessFetching=true;mount();
  expect(screen.getByText(/جارٍ التحقق من موانع الإقفال/)).toBeInTheDocument();
  expect(screen.getByRole("button",{name:"اعتماد وإقفال المراجعة"})).toBeDisabled();
 });
 it("never treats a drifted locked period as a certified statement",()=>{
  state.readinessStatus="BLOCKED";state.reviewStatus="locked";state.drift=true;
  state.invoiceCount=0;state.inventoryCount=0;mount();
  expect(screen.getByText(/تغيّرت مصادر البيانات بعد الإقفال/)).toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"اعتماد وإقفال المراجعة"})).not.toBeInTheDocument();
 });
});
