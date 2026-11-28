// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import FinancialSupplierPaymentCorrectionWorkspace from "./FinancialSupplierPaymentCorrectionWorkspace";

const state=vi.hoisted(()=>({
  online:true, actor:4, perms:["manageSupplierPayments","reverseSupplierPayments","viewFinancialReports"],
  queueError:false,sourceVerified:true,sourceFetching:false,request:vi.fn(),approve:vi.fn(),
  refetch:vi.fn(),invalidate:vi.fn().mockResolvedValue(undefined),
}));
const query=(data:unknown,error=false,fetching=false)=>({
  data,isLoading:false,isFetching:fetching,isError:error,
  isSuccess:!error,isFetchedAfterMount:true,isPlaceholderData:false,refetch:state.refetch,
});
vi.mock("@/_core/hooks/useAuth",()=>({useAuth:()=>({user:{id:state.actor},isAuthenticated:true})}));
vi.mock("@/lib/offline-connectivity",()=>({
  usePowerHubConnectivity:()=>({isOnline:state.online,isChecking:false}),
  getPowerHubConnectivitySnapshot:()=>state.online,
}));
vi.mock("@/lib/trpc",()=>({
  trpc:{
    useUtils:()=>({powerhub:{
      inventory:{
        listSupplierPaymentHistory:{invalidate:state.invalidate},
        supplierLedgerStatement:{invalidate:state.invalidate},
        supplierPayablesAging:{invalidate:state.invalidate},
      },
      reports:{
        financialSupplierPaymentCorrectionPending:{invalidate:state.invalidate},
        financialSupplierPaymentCorrectionReadiness:{invalidate:state.invalidate},
        financialGLCompanyMovementAudit:{invalidate:state.invalidate},
        financialGLSourceCoverage:{invalidate:state.invalidate},
        financialGLCorrectionReadiness:{invalidate:state.invalidate},
      },
    }}),
    powerhub:{
      staff:{myAccess:{useQuery:()=>query({permissions:state.perms,role:"accountant"})}},
      reports:{
        financialSupplierPaymentCorrectionReadiness:{useQuery:()=>query({
          siteId:1,paymentId:5,originalGLEntryId:857,paymentAmount:210,
          sourceEvidenceVerified:state.sourceVerified,
          status:state.sourceVerified?"SOURCE_VERIFIED_WORKFLOW_NOT_IMPLEMENTED":"SOURCE_INTEGRITY_BLOCKED",
          accountingCertification:"NOT_CERTIFIED",
        },false,state.sourceFetching)},
        financialSupplierPaymentCorrectionPending:{useQuery:()=>query({
          siteId:1,tenantId:1,accountingCertification:"NOT_CERTIFIED",
          items:[
            {correctionId:100,paymentId:5,requestedByUserId:4,originalGLEntryId:857,amount:"210",
             reason:"مستند استرداد اختباري",requestedAt:"2026-11-12",status:"pending_review"},
            {correctionId:101,paymentId:5,requestedByUserId:260,originalGLEntryId:857,amount:"210",
             reason:"مستند استرداد آخر",requestedAt:"2026-11-12",status:"pending_review"},
          ],hasMore:false,nextBeforeId:null,
        },state.queueError)},
        financialSupplierPaymentCorrectionRequest:{useMutation:()=>({
          mutate:state.request,isPending:false,
        })},
        financialSupplierPaymentCorrectionApprovePost:{useMutation:()=>({
          mutate:state.approve,isPending:false,
        })},
      },
    },
  },
}));
const mount=()=>render(<FinancialSupplierPaymentCorrectionWorkspace
  siteId={1} isAuthenticated={true} selectedPaymentId={null}/>);
beforeEach(()=>{
  state.online=true;state.actor=4;
  state.perms=["manageSupplierPayments","reverseSupplierPayments","viewFinancialReports"];
  state.queueError=false;state.sourceVerified=true;state.sourceFetching=false;
  state.request.mockReset();state.approve.mockReset();state.refetch.mockReset();state.invalidate.mockClear();
});
afterEach(()=>cleanup());

describe("B4.16 interactive maker/checker UX with mocked authenticated RPC",()=>{
  it("never offers financial actions offline",()=>{
    state.online=false;mount();
    fireEvent.click(screen.getByRole("button",{name:"فتح تصحيح GL"}));
    expect(screen.getByText(/يلزم اتصال موثوق/)).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"مراجعة الطلب"})).not.toBeInTheDocument();
    expect(state.approve).not.toHaveBeenCalled();
  });
  it("hides supplier financial data without the third report capability",()=>{
    state.perms=["manageSupplierPayments","reverseSupplierPayments"];
    mount();fireEvent.click(screen.getByRole("button",{name:"فتح تصحيح GL"}));
    expect(screen.getByText(/يلزم عرض التقارير المالية/)).toBeInTheDocument();
    expect(screen.queryByText(/طلب #100/)).not.toBeInTheDocument();
  });
  it("rejects an unverified original GL source before showing request action",()=>{
    state.sourceVerified=false;mount();
    fireEvent.click(screen.getByRole("button",{name:"فتح تصحيح GL"}));
    fireEvent.change(screen.getByRole("textbox",{name:"رقم دفعة المورد"}),{target:{value:"5"}});
    expect(screen.getByText(/المصدر غير مؤهل/)).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"إعداد طلب تصحيح المورد"})).not.toBeInTheDocument();
  });
  it("requires evidence, reason and explicit maker confirmation",()=>{
    mount();fireEvent.click(screen.getByRole("button",{name:"فتح تصحيح GL"}));
    fireEvent.change(screen.getByRole("textbox",{name:"رقم دفعة المورد"}),{target:{value:"5"}});
    const action=screen.getByRole("button",{name:"إعداد طلب تصحيح المورد"});
    expect(action).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("مرجع مستند الاسترداد، لا رقمًا صوريًا"),{
      target:{value:"DOCUMENT-12345"},
    });
    fireEvent.change(screen.getByPlaceholderText("اشرح الخطأ وسبب الاسترداد"),{
      target:{value:"استرداد قيمة دفعة مورد مدخلة بالخطأ"},
    });
    expect(action).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox",{name:/أؤكد أن استرداد المبلغ/}));
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(state.request).toHaveBeenCalledWith(expect.objectContaining({
      siteId:1,paymentId:5,reason:expect.stringContaining("DOCUMENT-12345"),
      operationKey:expect.stringMatching(/^supplier-source-correction:/),
    }));
    expect(state.approve).not.toHaveBeenCalled();
  });
  it("blocks self-approval and requires independent checker acknowledgement",()=>{
    mount();fireEvent.click(screen.getByRole("button",{name:"فتح تصحيح GL"}));
    expect(screen.getByText(/لا تستطيع اعتماد طلب أعددته بنفسك/)).toBeInTheDocument();
    const review=screen.getByRole("button",{name:"مراجعة الطلب"});
    fireEvent.click(review);
    const approve=screen.getByRole("button",{name:"اعتماد التصحيح الموثق"});
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox",{name:/تحققت كمراجع مستقل/}));
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    expect(state.approve).toHaveBeenCalledWith({
      siteId:1,correctionId:101,confirmIndependentReview:true,
    });
  });
  it("fails closed on reviewer queue errors",()=>{
    state.queueError=true;mount();
    fireEvent.click(screen.getByRole("button",{name:"فتح تصحيح GL"}));
    expect(screen.getByText(/تعذّر التحقق من الطلبات/)).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"مراجعة الطلب"})).not.toBeInTheDocument();
  });
});
