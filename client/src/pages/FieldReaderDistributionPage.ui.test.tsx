// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FieldReaderDistributionPage from "./FieldReaderDistributionPage";
const state = vi.hoisted(() => ({
  location: "/field-distribution?view=unassigned",
  move: vi.fn(),
  targetData: { items: [
    { subscriberId:501,subscriberNo:"SUB-501",fullName:"مشترك قديم",phone:"0590000501",address:"الشارع القديم",createdAt:"2024-01-01T00:00:00.000Z",assignedReaderUserId:null,assignedReaderName:null,assignedReaderEmail:null,isUnassigned:true,unassignedReason:"missing_assignment" },
    { subscriberId:502,subscriberNo:"SUB-502",fullName:"مشترك جديد",phone:"0590000502",address:"الشارع الجديد",createdAt:"2026-11-02T00:00:00.000Z",assignedReaderUserId:null,assignedReaderName:null,assignedReaderEmail:null,isUnassigned:true,unassignedReason:"missing_assignment" },
  ], totalCount:2 },
}));
vi.mock("@/_core/hooks/useAuth",()=>({useAuth:()=>({user:{id:1,role:"user"}})}));
vi.mock("@/components/DashboardLayout",()=>({default:({children}:{children:React.ReactNode})=><>{children}</>}));
vi.mock("@/hooks/useBranchFilter",()=>({useBranchFilter:()=>({branchId:11,setBranchId:vi.fn()})}));
vi.mock("wouter",()=>({useLocation:()=>[state.location,vi.fn()]}));
vi.mock("sonner",()=>({toast:{success:vi.fn(),error:vi.fn()}}));
vi.mock("@/lib/offline-connectivity",()=>({usePowerHubConnectivity:()=>({isOnline:true,isChecking:false})}));
vi.mock("@/lib/trpc",()=>({trpc:{powerhub:{
  sites:{list:{useQuery:()=>({data:[{id:11,name:"الفرع الرئيسي"}],isLoading:false})}},
  staff:{
    myAccess:{useQuery:()=>({data:{role:"owner"},isLoading:false})},
    readingDistribution:{useQuery:()=>({data:{isEnabled:true,readerUserIds:[10,11],assignedSubscriberCount:10,unassignedSubscriberCount:2},isLoading:false,refetch:vi.fn()})},
    list:{useQuery:()=>({data:[
      {profile:{role:"technician",isActive:true,archivedAt:null,permissions:["recordReadings","accessFieldApp"],suspensionStartedAt:null,suspensionEndsAt:null},user:{id:10,name:"قارئ أول",email:"reader1@test.local",accountStatus:"active"}},
      {profile:{role:"technician",isActive:true,archivedAt:null,permissions:["recordReadings","accessFieldApp"],suspensionStartedAt:null,suspensionEndsAt:null},user:{id:11,name:"قارئ ثان",email:"reader2@test.local",accountStatus:"active"}},
    ],isLoading:false})},
    allowedSubaccountRoles:{useQuery:()=>({data:{fieldUserLimit:3,fieldUserCount:2},isLoading:false})},
    fieldReaderAssignments:{useQuery:()=>({data:state.targetData,isLoading:false,refetch:vi.fn()})},
    moveFieldReaderSubscriber:{useMutation:()=>({mutate:state.move,isPending:false})},
  }
}}}));
afterEach(()=>{state.move.mockReset();state.location="/field-distribution?view=unassigned";});
describe("إدارة مشتركي الميدان",()=>{
  it("يعرض المشتركين غير المفرزين القدامى والجدد",()=>{
    render(<FieldReaderDistributionPage/>);
    expect(screen.getByText("مشترك قديم")).toBeInTheDocument();
    expect(screen.getByText("مشترك جديد")).toBeInTheDocument();
    expect(screen.getAllByText(/تاريخ الإضافة:/)).toHaveLength(2);
  });
  it("يسند مشتركًا غير مفرز إلى قارئ نشط مختار",()=>{
    render(<FieldReaderDistributionPage/>);
    fireEvent.change(screen.getByLabelText("مدخل القراءة للمشترك SUB-501"),{target:{value:"11"}});
    fireEvent.click(screen.getByRole("button",{name:"إسناد"}));
    expect(state.move).toHaveBeenCalledWith({siteId:11,subscriberId:501,targetReaderUserId:11});
  });
});
