/** Deterministic calendar-month choices for Arabic GL comparative reports.
 * Avoid native type=month partial-value normalization issues on some browsers.
 * No local-time or DST arithmetic; years and months are ordinal.
 */
const monthPattern=/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;
export function isEarlierGLPeriod(candidate:string,current:string):boolean{
 return monthPattern.test(candidate)&&monthPattern.test(current)&&candidate<current;
}
export function previousGLPeriodOptions(current:string,count=36):string[]{
 if(!monthPattern.test(current)||!Number.isSafeInteger(count)||count<1||count>120)
  return [];
 const year=Number(current.slice(0,4)),month=Number(current.slice(5,7));
 const ordinal=year*12+(month-1);
 const result:string[]=[];
 for(let shift=1;shift<=count;shift++){
  const v=ordinal-shift;
  if(v<12)break;
  const prevYear=Math.floor(v/12),prevMonth=v%12+1;
  if(prevYear>9999)continue;
  result.push(String(prevYear).padStart(4,"0")+"-"+String(prevMonth).padStart(2,"0"));
 }
 return result;
}
