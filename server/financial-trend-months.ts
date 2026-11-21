/** Calendar-month windows for bounded, on-demand cash-flow trend queries. */
export function financialTrendMonths(endDateInput: string, count = 6) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDateInput) || !Number.isInteger(count) || count < 1 || count > 12) {
    throw new Error("Invalid financial trend period");
  }
  const parsed = new Date(`${endDateInput}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== endDateInput) {
    throw new Error("Invalid financial trend date");
  }
  const anchor = parsed.getUTCFullYear()*12 + parsed.getUTCMonth();
  return Array.from({length:count},(_,index)=>{
    const monthIndex=anchor-count+1+index;
    const year=Math.floor(monthIndex/12);
    const month=monthIndex-year*12;
    const startDate=new Date(Date.UTC(year,month,1)).toISOString().slice(0,10);
    const monthEnd=new Date(Date.UTC(year,month+1,0)).toISOString().slice(0,10);
    const endDate=index===count-1 ? endDateInput : monthEnd;
    return {month:startDate.slice(0,7),startDate,endDate};
  });
}
