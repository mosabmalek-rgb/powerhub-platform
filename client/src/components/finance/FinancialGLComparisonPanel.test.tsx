// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import React from "react";

const spies=vi.hoisted(()=>({
 query:vi.fn((_input:unknown,_opts:unknown)=>({
  isSuccess:false,isError:false,isFetching:false,data:undefined,
 })),
 mutate:vi.fn(()=>({mutateAsync:vi.fn()})),
}));
vi.mock("@/lib/trpc",()=>({
 trpc:{powerhub:{reports:{
  financialGLMonthlyComparison:{useQuery:spies.query},
  financialGLMonthlyComparisonExport:{useMutation:spies.mutate},
 }}},
}));
vi.mock("@/components/ui/button",()=>({
 Button:({children,disabled,onClick}:{
  children:React.ReactNode;disabled?:boolean;onClick?:()=>void
 })=><button type="button" disabled={disabled} onClick={onClick}>{children}</button>,
}));
vi.mock("sonner",()=>({toast:{error:vi.fn(),success:vi.fn()}}));
import FinancialGLComparisonPanel from "./FinancialGLComparisonPanel";
afterEach(()=>{cleanup();spies.query.mockClear();spies.mutate.mockClear();});

describe("Phase C accessible comparison month controls",()=>{
 it("sends October on demand for November without native month reset",()=>{
  render(<FinancialGLComparisonPanel siteId={1} period="2026-11" active/>);
  fireEvent.click(screen.getByRole("button",{name:"مقارنة الفترات"}));
  const select=screen.getByLabelText("الفترة السابقة") as HTMLSelectElement;
  expect(select.tagName).toBe("SELECT");
  expect(select.value).toBe("2026-10");
  fireEvent.click(screen.getByRole("button",{name:"عرض المقارنة"}));
  const calls=spies.query.mock.calls;
  expect(calls.at(-1)?.[0]).toEqual({
   siteId:1,currentPeriod:"2026-11",previousPeriod:"2026-10",
  });
  expect(calls.at(-1)?.[1]).toMatchObject({enabled:true});
 });
 it("accepts year boundary and older typed periods, clearing the old request on changes",()=>{
  render(<FinancialGLComparisonPanel siteId={1} period="2026-01" active/>);
  fireEvent.click(screen.getByRole("button",{name:"مقارنة الفترات"}));
  const select=screen.getByLabelText("الفترة السابقة") as HTMLSelectElement;
  expect(select.value).toBe("2025-12");
  fireEvent.change(select,{target:{value:"__custom"}});
  const input=screen.getByLabelText("شهر أقدم بصيغة YYYY-MM") as HTMLInputElement;
  fireEvent.change(input,{target:{value:"2024-03"}});
  fireEvent.click(screen.getByRole("button",{name:"عرض المقارنة"}));
  expect(spies.query.mock.calls.at(-1)?.[0]).toMatchObject({previousPeriod:"2024-03"});
  fireEvent.change(input,{target:{value:"2024-02"}});
  expect(spies.query.mock.calls.at(-1)?.[1]).toMatchObject({enabled:false});
 });
 it("resets the selection and query on branch or current period change",()=>{
  const view=render(<FinancialGLComparisonPanel siteId={1} period="2026-11" active/>);
  fireEvent.click(screen.getByRole("button",{name:"مقارنة الفترات"}));
  fireEvent.click(screen.getByRole("button",{name:"عرض المقارنة"}));
  view.rerender(<FinancialGLComparisonPanel siteId={2} period="2026-12" active/>);
  expect(screen.queryByLabelText("الفترة السابقة")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"مقارنة الفترات"}));
  expect((screen.getByLabelText("الفترة السابقة") as HTMLSelectElement).value).toBe("2026-11");
  expect(spies.query.mock.calls.at(-1)?.[1]).toMatchObject({enabled:false});
 });
});
